import { takeEvery, put, select, call, take, delay, apply, fork, race } from 'redux-saga/effects'

import { Authenticator } from '@dcl/crypto'
import {
  SocialClient,
  FriendshipRequest,
  Conversation,
  PresenceType,
  CurrentUserStatus,
  UnknownUsersError,
  SocialAPI,
  UpdateUserStatus,
  ConversationType,
  ChannelsError,
  ChannelErrorKind,
  GetOrCreateConversationResponse
} from 'dcl-social-client'

import { DEBUG_KERNEL_LOG } from 'config'
import { deepEqual } from 'atomicHelpers/deepEqual'

import defaultLogger, { createLogger, createDummyLogger } from 'shared/logger'
import {
  ChatMessage,
  NotificationType,
  ChatMessageType,
  FriendshipAction,
  PresenceStatus,
  FriendsInitializationMessage,
  GetFriendsPayload,
  AddFriendsPayload,
  GetFriendRequestsPayload,
  AddFriendRequestsPayload,
  UpdateUserUnseenMessagesPayload,
  UpdateTotalUnseenMessagesPayload,
  AddChatMessagesPayload,
  GetFriendsWithDirectMessagesPayload,
  AddFriendsWithDirectMessagesPayload,
  UpdateTotalUnseenMessagesByUserPayload,
  UpdateTotalFriendRequestsPayload,
  FriendsInitializeChatPayload,
  MarkMessagesAsSeenPayload,
  GetPrivateMessagesPayload,
  CreateChannelPayload,
  UpdateTotalUnseenMessagesByChannelPayload,
  GetJoinedChannelsPayload,
  ChannelInfoPayload,
  MarkChannelMessagesAsSeenPayload,
  GetChannelMessagesPayload,
  ChannelErrorPayload,
  ChannelErrorCode,
  MuteChannelPayload,
  GetChannelInfoPayload,
  GetChannelMembersPayload,
  UpdateChannelMembersPayload,
  GetChannelsPayload,
  ChannelSearchResultsPayload,
  JoinOrCreateChannelPayload,
  ChannelMember
} from 'shared/types'
import { waitForRendererInstance } from 'shared/renderer/sagas-helper'
import { getCurrentUserProfile, getProfile, getProfilesFromStore, isAddedToCatalog } from 'shared/profiles/selectors'
import { ExplorerIdentity } from 'shared/session/types'
import { SocialData, FriendsState, FriendRequest } from 'shared/friends/types'
import {
  getSocialClient,
  findPrivateMessagingFriendsByUserId,
  getPrivateMessaging,
  getPrivateMessagingFriends,
  getTotalFriendRequests,
  getTotalFriends,
  isFriend,
  getLastStatusOfFriends,
  getChannels,
  getAllFriendsConversationsWithMessages
} from 'shared/friends/selectors'
import { USER_AUTHENTIFIED } from 'shared/session/actions'
import { SEND_PRIVATE_MESSAGE, SendPrivateMessage } from 'shared/chat/actions'
import {
  updateFriendship,
  UPDATE_FRIENDSHIP,
  UpdateFriendship,
  updatePrivateMessagingState,
  updateUserData,
  setMatrixClient,
  SET_MATRIX_CLIENT,
  SetMatrixClient,
  JOIN_OR_CREATE_CHANNEL,
  JoinOrCreateChannel,
  LeaveChannel,
  LEAVE_CHANNEL,
  SEND_CHANNEL_MESSAGE,
  SendChannelMessage
} from 'shared/friends/actions'
import { waitForRoomConnection } from 'shared/dao/sagas'
import { getUnityInstance } from 'unity-interface/IUnityInterface'
import { ensureFriendProfile } from './ensureFriendProfile'
import { getFeatureFlagEnabled, getSynapseUrl } from 'shared/meta/selectors'
import { SET_ROOM_CONNECTION } from 'shared/comms/actions'
import {
  ensureRealmAdapterPromise,
  getFetchContentUrlPrefixFromRealmAdapter,
  getRealmConnectionString
} from 'shared/realm/selectors'
import { Avatar, EthAddress } from '@dcl/schemas'
import { trackEvent } from '../analytics'
import { getCurrentIdentity, getCurrentUserId, getIsGuestLogin } from 'shared/session/selectors'
import { store } from 'shared/store/isolatedStore'
import { getPeer } from 'shared/comms/peers'
import { waitForMetaConfigurationInitialization } from 'shared/meta/sagas'
import { ProfileUserInfo } from 'shared/profiles/types'
import { defaultProfile, profileToRendererFormat } from 'shared/profiles/transformations/profileToRendererFormat'
import { addedProfilesToCatalog } from 'shared/profiles/actions'
import {
  getUserIdFromMatrix,
  getMatrixIdFromUser,
  areChannelsEnabled,
  getMaxChannels,
  getNormalizedRoomName,
  getUsersAllowedToCreate
} from './utils'
import { AuthChain } from '@dcl/kernel-interface/dist/dcl-crypto'
import { mutePlayers, unmutePlayers } from 'shared/social/actions'
import { getParcelPosition } from 'shared/scene-loader/selectors'
import { OFFLINE_REALM } from 'shared/realm/types'
import { calculateDisplayName } from 'shared/profiles/transformations/processServerProfile'
import { uuid } from 'atomicHelpers/math'
import { NewProfileForRenderer } from 'shared/profiles/transformations/types'

const logger = DEBUG_KERNEL_LOG ? createLogger('chat: ') : createDummyLogger()

const receivedMessages: Record<string, number> = {}

const MESSAGE_LIFESPAN_MILLIS = 1_000
const SEND_STATUS_INTERVAL_MILLIS = 60_000
const MIN_TIME_BETWEEN_FRIENDS_INITIALIZATION_RETRIES_MILLIS = 1000
const MAX_TIME_BETWEEN_FRIENDS_INITIALIZATION_RETRIES_MILLIS = 256000

export function* friendsSaga() {
  // We don't want to initialize the friends & chat feature if we are on preview or builder mode
  yield fork(initializeFriendsSaga)
  yield fork(initializeStatusUpdateInterval)
  yield fork(initializeReceivedMessagesCleanUp)

  yield takeEvery(SET_MATRIX_CLIENT, configureMatrixClient)
  yield takeEvery(UPDATE_FRIENDSHIP, trackEvents)
  yield takeEvery(UPDATE_FRIENDSHIP, handleUpdateFriendship)
  yield takeEvery(SEND_PRIVATE_MESSAGE, handleSendPrivateMessage)
  yield takeEvery(SEND_CHANNEL_MESSAGE, handleSendChannelMessage)
  yield takeEvery(JOIN_OR_CREATE_CHANNEL, handleJoinOrCreateChannel)
  yield takeEvery(LEAVE_CHANNEL, handleLeaveChannel)
}

function* initializeFriendsSaga() {
  let secondsToRetry = MIN_TIME_BETWEEN_FRIENDS_INITIALIZATION_RETRIES_MILLIS

  yield call(waitForMetaConfigurationInitialization)

  // this reconnection breaks the server. setting to false
  const shouldRetryReconnection = yield select(getFeatureFlagEnabled, 'retry_matrix_login')
  const chatDisabled = yield select(getFeatureFlagEnabled, 'matrix_disabled')

  if (chatDisabled) return

  do {
    yield race({
      auth: take(USER_AUTHENTIFIED),
      delay: delay(secondsToRetry)
    })

    yield call(waitForRoomConnection)
    yield call(waitForRendererInstance)

    const currentIdentity: ExplorerIdentity | undefined = yield select(getCurrentIdentity)

    const isGuest = yield select(getIsGuestLogin)

    // guests must not use the friends & private messaging features
    if (isGuest) return

    const client: SocialAPI | null = yield select(getSocialClient)

    try {
      const isLoggedIn: boolean = (currentIdentity && client && (yield apply(client, client.isLoggedIn, []))) || false

      const shouldRetry = !isLoggedIn && !isGuest

      if (shouldRetry) {
        try {
          logger.log('[Social client] Initializing')
          yield call(initializePrivateMessaging)
          logger.log('[Social client] Initialized')
          // restart the debounce
          secondsToRetry = MIN_TIME_BETWEEN_FRIENDS_INITIALIZATION_RETRIES_MILLIS
        } catch (e) {
          logAndTrackError(`Error initializing private messaging`, e)

          if (secondsToRetry < MAX_TIME_BETWEEN_FRIENDS_INITIALIZATION_RETRIES_MILLIS) {
            secondsToRetry *= 1.5
          }
        }
      }
    } catch (e) {
      logAndTrackError('Error while logging in to chat service', e)
    }
  } while (shouldRetryReconnection)
}

async function handleIncomingFriendshipUpdateStatus(action: FriendshipAction, socialId: string) {
  logger.info(`handleIncomingFriendshipUpdateStatus`, action, socialId)

  // map social id to user id
  const userId = parseUserId(socialId)

  if (!userId) {
    logger.warn(`cannot parse user id from social id`, socialId)
    return null
  }

  store.dispatch(updateUserData(userId, socialId))

  // ensure user profile is initialized and send to renderer
  await ensureFriendProfile(userId)

  // add to friendRequests & update renderer
  store.dispatch(updateFriendship(action, userId, true))
}

function* configureMatrixClient(action: SetMatrixClient) {
  const client = action.payload.socialApi
  const identity: ExplorerIdentity | undefined = yield select(getCurrentIdentity)

  const friendsResponse: { friendsSocial: SocialData[]; ownId: string } | undefined = yield call(refreshFriends)

  if (!friendsResponse) {
    // refreshFriends might fail and return with no actual data
    return
  }

  const { ownId } = friendsResponse

  if (!identity) {
    return
  }

  // check channels feature is enabled
  const channelsDisabled = !areChannelsEnabled()

  // initialize conversations
  client.onStatusChange(async (socialId, status) => {
    try {
      const userId = parseUserId(socialId)
      if (userId) {
        // When it's a friend and is not added to catalog
        // unity needs to know this information to show that the user has connected
        if (isFriend(store.getState(), userId)) {
          if (!isAddedToCatalog(store.getState(), userId)) {
            await ensureFriendProfile(userId)
          }
          getUnityInstance().AddFriends({
            friends: [userId],
            totalFriends: getTotalFriends(store.getState())
          })
        }

        sendUpdateUserStatus(userId, status)
      }
    } catch (error) {
      const message = 'Failed while processing friend status change'
      defaultLogger.error(message, error)

      trackEvent('error', {
        context: 'kernel#saga',
        message: message,
        stack: '' + error
      })
    }
  })

  client.onMessage(async (conversation, message) => {
    try {
      const isChannelType = conversation.type === ConversationType.CHANNEL

      if (isChannelType && channelsDisabled) {
        return
      }
      if (receivedMessages.hasOwnProperty(message.id)) {
        // message already processed, skipping
        return
      } else {
        receivedMessages[message.id] = Date.now()
      }

      const senderUserId = parseUserId(message.sender)

      if (!senderUserId) {
        logger.error('unknown message', message, conversation)
        return
      }

      const profile = getProfile(store.getState(), identity.address)
      const blocked = profile?.blocked ?? []
      if (blocked.includes(senderUserId)) {
        return
      }

      const recipient = isChannelType ? conversation.id : message.sender === ownId ? senderUserId : identity.address
      const messageType = isChannelType ? ChatMessageType.PUBLIC : ChatMessageType.PRIVATE
      const chatMessage = {
        messageId: message.id,
        messageType,
        timestamp: message.timestamp,
        body: message.text,
        sender: message.sender === ownId ? identity.address : senderUserId,
        recipient
      }

      const userProfile = getProfile(store.getState(), senderUserId)
      if (!userProfile || !isAddedToCatalog(store.getState(), senderUserId)) {
        await ensureFriendProfile(senderUserId)
      }

      if (message.sender === ownId && !isChannelType) {
        // ignore messages sent to private chats by the local user
        return
      }

      addNewChatMessage(chatMessage)

      if (isChannelType) {
        const muted = profile?.muted ?? []
        if (!muted.includes(conversation.id)) {
          // send update with unseen messages by channel
          getUnseenMessagesByChannel()
        }
      } else {
        const unreadMessages = client.getConversationUnreadMessages(conversation.id).length

        const updateUnseenMessages: UpdateUserUnseenMessagesPayload = {
          userId: senderUserId,
          total: unreadMessages
        }

        getUnityInstance().UpdateUserUnseenMessages(updateUnseenMessages)
      }

      // send total unseen messages update
      const totalUnreadMessages = getTotalUnseenMessages(client, ownId, getFriendIds(client))
      const updateTotalUnseenMessages: UpdateTotalUnseenMessagesPayload = {
        total: totalUnreadMessages
      }
      getUnityInstance().UpdateTotalUnseenMessages(updateTotalUnseenMessages)
    } catch (error) {
      const message = 'Failed while processing message'
      defaultLogger.error(message, error)

      trackEvent('error', {
        context: 'kernel#saga',
        message: message,
        stack: '' + error
      })
    }
  })

  client.onFriendshipRequest((socialId) =>
    handleIncomingFriendshipUpdateStatus(FriendshipAction.REQUESTED_FROM, socialId).catch((error) => {
      const message = 'Failed while processing friendship request'
      defaultLogger.error(message, error)

      trackEvent('error', {
        context: 'kernel#saga',
        message: message,
        stack: '' + error
      })
    })
  )

  client.onFriendshipRequestCancellation((socialId) =>
    handleIncomingFriendshipUpdateStatus(FriendshipAction.CANCELED, socialId)
  )

  client.onFriendshipRequestApproval(async (socialId) => {
    await handleIncomingFriendshipUpdateStatus(FriendshipAction.APPROVED, socialId)
    updateUserStatus(client, socialId)
  })

  client.onFriendshipDeletion((socialId) => handleIncomingFriendshipUpdateStatus(FriendshipAction.DELETED, socialId))

  client.onFriendshipRequestRejection((socialId) =>
    handleIncomingFriendshipUpdateStatus(FriendshipAction.REJECTED, socialId)
  )

  client.onChannelMembers((conversation, members) => {
    if (!areChannelsEnabled()) return

    if (conversation.name && !conversation.name.startsWith('Empty room')) {
      updateChannelInfo(conversation, client)
    }

    // we only notify members who are online
    const memberIds = members.map((member) => member.userId)
    const onlineMemberIds = getOnlineMembers(memberIds, client)

    const channelMembers: ChannelMember[] = members
      .filter((member) => onlineMemberIds.includes(member.userId))
      .map((member) => ({
        userId: getUserIdFromMatrix(member.userId),
        name: member.name,
        isOnline: true
      }))

    const update: UpdateChannelMembersPayload = { channelId: conversation.id, members: channelMembers }
    getUnityInstance().UpdateChannelMembers(update)
  })

  client.onChannelMembership((conversation, membership) => {
    if (!areChannelsEnabled()) return

    switch (membership) {
      case 'join':
        if (!conversation.name || conversation.name?.startsWith('Empty room')) {
          break
        }

        const onlineMembers = getOnlineMembersCount(client, conversation.userIds)

        const channel: ChannelInfoPayload = {
          name: getNormalizedRoomName(conversation.name),
          channelId: conversation.id,
          unseenMessages: conversation.unreadMessages?.length ?? 0,
          lastMessageTimestamp: conversation.lastEventTimestamp ?? undefined,
          memberCount: onlineMembers,
          description: '',
          joined: true,
          muted: false
        }

        getUnityInstance().JoinChannelConfirmation({ channelInfoPayload: [channel] })
        break
      case 'leave':
        const joinedMembers = client.getChannel(conversation.id)?.userIds?.length ?? 0
        const leavingChannelPayload: ChannelInfoPayload = {
          name: conversation.name ?? '',
          channelId: conversation.id,
          unseenMessages: 0,
          lastMessageTimestamp: undefined,
          memberCount: joinedMembers,
          description: '',
          joined: false,
          muted: false
        }

        // send total unseen messages update
        const totalUnreadMessages = getTotalUnseenMessages(client, client.getUserId(), getFriendIds(client))
        const updateTotalUnseenMessages: UpdateTotalUnseenMessagesPayload = {
          total: totalUnreadMessages
        }

        getUnityInstance().UpdateTotalUnseenMessages(updateTotalUnseenMessages)
        getUnityInstance().UpdateChannelInfo({ channelInfoPayload: [leavingChannelPayload] })
        break
    }
  })
}

function updateChannelInfo(conversation: Conversation, client: SocialAPI) {
  const onlineMembers = getOnlineMembersCount(client, conversation.userIds)
  const profile = getCurrentUserProfile(store.getState())
  const muted = profile?.muted?.includes(conversation.id) ?? false

  const channel = {
    name: getNormalizedRoomName(conversation.name || ''),
    channelId: conversation.id,
    unseenMessages: muted ? 0 : conversation.unreadMessages?.length || 0,
    lastMessageTimestamp: conversation.lastEventTimestamp || undefined,
    memberCount: onlineMembers,
    description: '',
    joined: true,
    muted
  }

  getUnityInstance().UpdateChannelInfo({ channelInfoPayload: [channel] })
}

// this saga needs to throw in case of failure
function* initializePrivateMessaging() {
  const synapseUrl: string = yield select(getSynapseUrl)
  const identity: ExplorerIdentity | undefined = yield select(getCurrentIdentity)

  if (!identity) return

  const { address: ethAddress } = identity
  const timestamp: number = Date.now()

  // TODO: the "timestamp" should be a message also signed by a catalyst.
  const messageToSign = `${timestamp}`

  const authChain = Authenticator.signPayload(identity, messageToSign)

  const disablePresence = yield select(getFeatureFlagEnabled, 'matrix_presence_disabled')

  const client: SocialAPI = yield apply(SocialClient, SocialClient.loginToServer, [
    synapseUrl,
    ethAddress,
    timestamp,
    authChain as AuthChain,
    {
      disablePresence
    }
  ])

  const profile: Avatar | null = yield select(getCurrentUserProfile)
  if (profile) {
    const displayName = calculateDisplayName(profile)
    yield apply(client, client.setProfileInfo, [{ displayName }])
  }

  yield put(setMatrixClient(client))
}

function* refreshFriends() {
  try {
    const client: SocialAPI | null = yield select(getSocialClient)

    if (!client) return

    const ownId = client.getUserId()

    // init friends
    const friendIds: string[] = yield getFriendIds(client)
    const friendsSocial: SocialData[] = []

    // init friend requests
    const friendRequests: FriendshipRequest[] = yield client.getPendingRequests()

    // filter my requests to others
    const toFriendRequests = friendRequests.filter((request) => request.from === ownId)
    const toFriendRequestsIds = toFriendRequests.map((request) => request.to)
    const toFriendRequestsSocial = toSocialData(toFriendRequestsIds)

    // filter other requests to me
    const fromFriendRequests = friendRequests.filter((request) => request.to === ownId)
    const fromFriendRequestsIds = fromFriendRequests.map((request) => request.from)
    const fromFriendRequestsSocial = toSocialData(fromFriendRequestsIds)

    const socialInfo: Record<string, SocialData> = [
      ...friendsSocial,
      ...toFriendRequestsSocial,
      ...fromFriendRequestsSocial
    ].reduce(
      (acc, current) => ({
        ...acc,
        [current.socialId]: current
      }),
      {}
    )

    const requestedFromIds = fromFriendRequests.map(
      (request): FriendRequest => ({
        createdAt: request.createdAt,
        userId: getUserIdFromMatrix(request.from)
      })
    )
    const requestedToIds = toFriendRequests.map(
      (request): FriendRequest => ({
        createdAt: request.createdAt,
        userId: getUserIdFromMatrix(request.to)
      })
    )

    // explorer information
    const totalUnseenMessages = getTotalUnseenMessages(client, ownId, friendIds)

    const initFriendsMessage: FriendsInitializationMessage = {
      totalReceivedRequests: requestedFromIds.length
    }
    const initChatMessage: FriendsInitializeChatPayload = {
      totalUnseenMessages
    }

    defaultLogger.log('____ initMessage ____', initFriendsMessage)
    defaultLogger.log('____ initChatMessage ____', initChatMessage)

    // all profiles to obtain, deduped
    const allProfilesToObtain: string[] = friendIds
      .concat(requestedFromIds.map((x) => x.userId))
      .concat(requestedToIds.map((x) => x.userId))
      .filter((each, i, elements) => elements.indexOf(each) === i)

    const ensureFriendProfilesPromises = allProfilesToObtain.map((userId) => ensureFriendProfile(userId))
    yield Promise.all(ensureFriendProfilesPromises).catch(logger.error)

    getUnityInstance().InitializeFriends(initFriendsMessage)
    getUnityInstance().InitializeChat(initChatMessage)

    yield put(
      updatePrivateMessagingState({
        client,
        socialInfo,
        friends: friendIds,
        fromFriendRequests: requestedFromIds,
        toFriendRequests: requestedToIds,
        // initialize an empty map because there is no way to get the current statuses, the matrix client store is empty at this point
        lastStatusOfFriends: new Map()
      })
    )

    return { friendsSocial, ownId }
  } catch (e) {
    logAndTrackError('Error while refreshing friends', e)
  }
}

function getFriendIds(client: SocialAPI): string[] {
  const friends: string[] = client.getAllFriends()

  return friends.map(($) => parseUserId($)).filter(Boolean) as string[]
}

function getTotalUnseenMessages(client: SocialAPI, ownId: string, friendIds: string[]): number {
  const channelsDisabled = !areChannelsEnabled()
  const profile = getCurrentUserProfile(store.getState())

  const conversationsWithUnreadMessages: Conversation[] = client.getAllConversationsWithUnreadMessages()
  let totalUnseenMessages = 0

  for (const conv of conversationsWithUnreadMessages) {
    if (conv.type === ConversationType.CHANNEL) {
      if (channelsDisabled || profile?.muted?.includes(conv.id)) {
        continue
      }
    } else if (conv.type === ConversationType.DIRECT) {
      const socialId = conv.userIds?.find((userId) => userId !== ownId)
      if (!socialId) {
        continue
      }

      const userId = getUserIdFromMatrix(socialId)

      if (!friendIds.some((friendIds) => friendIds === userId)) {
        continue
      }
    }
    totalUnseenMessages += conv.unreadMessages?.length || 0
  }

  return totalUnseenMessages
}

export async function getFriends(request: GetFriendsPayload) {
  // ensure friend profiles are sent to renderer
  const realmAdapter = await ensureRealmAdapterPromise()
  const fetchContentServerWithPrefix = getFetchContentUrlPrefixFromRealmAdapter(realmAdapter)
  const friendsIds: string[] = getPrivateMessagingFriends(store.getState())

  const filteredFriends: Array<ProfileUserInfo> = getProfilesFromStore(
    store.getState(),
    friendsIds,
    request.userNameOrId
  )

  const friendsToReturn = filteredFriends.slice(request.skip, request.skip + request.limit)

  const profilesForRenderer = friendsToReturn.map((profile) =>
    profileToRendererFormat(profile.data, {
      baseUrl: fetchContentServerWithPrefix
    })
  )
  getUnityInstance().AddUserProfilesToCatalog({ users: profilesForRenderer })

  const friendIdsToReturn = friendsToReturn.map((friend) => friend.data.userId)

  const addFriendsPayload: AddFriendsPayload = {
    friends: friendIdsToReturn,
    totalFriends: friendsIds.length
  }

  getUnityInstance().AddFriends(addFriendsPayload)

  store.dispatch(addedProfilesToCatalog(friendsToReturn.map((friend) => friend.data)))

  const client = getSocialClient(store.getState())
  if (!client) {
    return
  }

  const friendsSocialIds = friendIdsToReturn.map(getMatrixIdFromUser)
  updateUserStatus(client, ...friendsSocialIds)
}

export async function getFriendRequests(request: GetFriendRequestsPayload) {
  const friends: FriendsState = getPrivateMessaging(store.getState())
  const realmAdapter = await ensureRealmAdapterPromise()
  const fetchContentServerWithPrefix = getFetchContentUrlPrefixFromRealmAdapter(realmAdapter)

  const fromFriendRequests = friends.fromFriendRequests.slice(
    request.receivedSkip,
    request.receivedSkip + request.receivedLimit
  )
  const toFriendRequests = friends.toFriendRequests.slice(request.sentSkip, request.sentSkip + request.sentLimit)

  const addFriendRequestsPayload: AddFriendRequestsPayload = {
    requestedTo: toFriendRequests.map((friend) => friend.userId),
    requestedFrom: fromFriendRequests.map((friend) => friend.userId),
    totalReceivedFriendRequests: friends.fromFriendRequests.length,
    totalSentFriendRequests: friends.toFriendRequests.length
  }

  // get friend requests profiles
  const friendsIds = addFriendRequestsPayload.requestedTo.concat(addFriendRequestsPayload.requestedFrom)
  const friendRequestsProfiles: ProfileUserInfo[] = getProfilesFromStore(store.getState(), friendsIds)
  const profilesForRenderer = friendRequestsProfiles.map((friend) =>
    profileToRendererFormat(friend.data, {
      baseUrl: fetchContentServerWithPrefix
    })
  )

  // send friend requests profiles
  getUnityInstance().AddUserProfilesToCatalog({ users: profilesForRenderer })
  store.dispatch(addedProfilesToCatalog(friendRequestsProfiles.map((friend) => friend.data)))

  // send friend requests
  getUnityInstance().AddFriendRequests(addFriendRequestsPayload)
}

export async function markAsSeenPrivateChatMessages(userId: MarkMessagesAsSeenPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  // get conversation id
  const conversationId = await getConversationId(client, userId.userId)

  // get user's chat unread messages
  const unreadMessages = client.getConversationUnreadMessages(conversationId).length

  if (unreadMessages > 0) {
    // mark as seen all the messages in the conversation
    await client.markMessagesAsSeen(conversationId)
  }

  // get total user unread messages
  const totalUnreadMessages = getTotalUnseenMessages(client, client.getUserId(), getFriendIds(client))

  const updateUnseenMessages: UpdateUserUnseenMessagesPayload = {
    userId: userId.userId,
    total: 0
  }
  const updateTotalUnseenMessages: UpdateTotalUnseenMessagesPayload = {
    total: totalUnreadMessages
  }

  getUnityInstance().UpdateUserUnseenMessages(updateUnseenMessages)
  getUnityInstance().UpdateTotalUnseenMessages(updateTotalUnseenMessages)
}

export async function getPrivateMessages(getPrivateMessagesPayload: GetPrivateMessagesPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  // get the conversation.id
  const conversationId = await getConversationId(client, getPrivateMessagesPayload.userId)

  const ownId = client.getUserId()

  // get cursor of the conversation located on the given message or at the end of the conversation if there is no given message.
  const messageId: string | undefined = !getPrivateMessagesPayload.fromMessageId
    ? undefined
    : getPrivateMessagesPayload.fromMessageId

  // the message in question is in the middle of a window, so we multiply by two the limit in order to get the required messages.
  let limit = getPrivateMessagesPayload.limit
  if (messageId !== undefined) {
    limit = limit * 2
  }

  const cursorMessage = await client.getCursorOnMessage(conversationId, messageId, {
    initialSize: limit,
    limit
  })

  if (!cursorMessage) return

  const messages = cursorMessage.getMessages()
  if (messageId !== undefined) {
    // we remove the messages they already have.
    const index = messages.map((messages) => messages.id).indexOf(messageId)
    messages.splice(index)
  }

  // parse messages
  const addChatMessagesPayload: AddChatMessagesPayload = {
    messages: messages.map((message) => ({
      messageId: message.id,
      messageType: ChatMessageType.PRIVATE,
      timestamp: message.timestamp,
      body: message.text,
      sender: message.sender === ownId ? getUserIdFromMatrix(ownId) : getPrivateMessagesPayload.userId,
      recipient: message.sender === ownId ? getPrivateMessagesPayload.userId : getUserIdFromMatrix(ownId)
    }))
  }

  getUnityInstance().AddChatMessages(addChatMessagesPayload)
}

export function getUnseenMessagesByUser() {
  const conversationsWithMessages = getAllFriendsConversationsWithMessages(store.getState())

  if (conversationsWithMessages.length === 0) {
    return
  }

  const updateTotalUnseenMessagesByUserPayload: UpdateTotalUnseenMessagesByUserPayload = { unseenPrivateMessages: [] }

  for (const conversation of conversationsWithMessages) {
    updateTotalUnseenMessagesByUserPayload.unseenPrivateMessages.push({
      count: conversation.conversation.unreadMessages?.length || 0,
      userId: conversation.conversation.userIds![1]
    })
  }

  getUnityInstance().UpdateTotalUnseenMessagesByUser(updateTotalUnseenMessagesByUserPayload)
}

export async function getFriendsWithDirectMessages(request: GetFriendsWithDirectMessagesPayload) {
  const realmAdapter = await ensureRealmAdapterPromise()
  const fetchContentServerWithPrefix = getFetchContentUrlPrefixFromRealmAdapter(realmAdapter)
  const conversationsWithMessages = getAllFriendsConversationsWithMessages(store.getState())

  if (conversationsWithMessages.length === 0) {
    return
  }

  const friendsIds: string[] = conversationsWithMessages
    .slice(request.skip, request.skip + request.limit)
    .map((conv) => conv.conversation.userIds![1])

  const filteredFriends: Array<ProfileUserInfo> = getProfilesFromStore(
    store.getState(),
    friendsIds,
    request.userNameOrId
  )

  const friendsConversations: Array<{ userId: string; conversation: Conversation; avatar: Avatar }> = []

  for (const friend of filteredFriends) {
    const conversation = conversationsWithMessages.find((conv) => conv.conversation.userIds![1] === friend.data.userId)

    if (conversation) {
      friendsConversations.push({
        userId: friend.data.userId,
        conversation: conversation.conversation,
        avatar: friend.data
      })
    }
  }

  const addFriendsWithDirectMessagesPayload: AddFriendsWithDirectMessagesPayload = {
    currentFriendsWithDirectMessages: friendsConversations.map((friend) => ({
      lastMessageTimestamp: friend.conversation.lastEventTimestamp!,
      userId: friend.userId
    })),
    totalFriendsWithDirectMessages: conversationsWithMessages.length
  }

  const profilesForRenderer = friendsConversations.map((friend) =>
    profileToRendererFormat(friend.avatar, {
      baseUrl: fetchContentServerWithPrefix
    })
  )

  getUnityInstance().AddUserProfilesToCatalog({ users: profilesForRenderer })
  store.dispatch(addedProfilesToCatalog(friendsConversations.map((friend) => friend.avatar)))

  getUnityInstance().AddFriendsWithDirectMessages(addFriendsWithDirectMessagesPayload)

  const client = getSocialClient(store.getState())
  if (!client) {
    return
  }

  const friendsSocialIds = filteredFriends.map((friend) => getMatrixIdFromUser(friend.data.userId))
  updateUserStatus(client, ...friendsSocialIds)
}

function* initializeReceivedMessagesCleanUp() {
  while (true) {
    yield delay(MESSAGE_LIFESPAN_MILLIS)
    const now = Date.now()

    Object.entries(receivedMessages)
      .filter(([, timestamp]) => now - timestamp > MESSAGE_LIFESPAN_MILLIS)
      .forEach(([id]) => delete receivedMessages[id])
  }
}

function isPeerAvatarAvailable(userId: string) {
  return !!getPeer(userId.toLowerCase())
}

function sendUpdateUserStatus(id: string, status: CurrentUserStatus) {
  const userId = parseUserId(id)

  if (!userId) return

  // treat 'unavailable' status as 'online'
  const isOnline = isPeerAvatarAvailable(userId) || status.presence !== PresenceType.OFFLINE

  const updateMessage = {
    userId,
    realm: status.realm,
    position: status.position,
    presence: isOnline ? PresenceStatus.ONLINE : PresenceStatus.OFFLINE
  }

  getUnityInstance().UpdateUserPresence(updateMessage)
}

function updateUserStatus(client: SocialAPI, ...socialIds: string[]) {
  const statuses = client.getUserStatuses(...socialIds)
  const lastStatuses = getLastStatusOfFriends(store.getState())

  statuses.forEach((value: CurrentUserStatus, key: string) => {
    const lastStatus = lastStatuses.get(key)
    // we do this in order to avoid sending already sent states.
    if (!lastStatus || !deepEqual(lastStatus, value)) {
      sendUpdateUserStatus(key, value)
      lastStatuses.set(key, value)
    }
  })
}

/**
 * This saga updates the status of our player for the Presence feature
 */
export function* initializeStatusUpdateInterval() {
  let lastStatus: UpdateUserStatus | undefined = undefined

  while (true) {
    yield race({
      SET_MATRIX_CLIENT: take(SET_MATRIX_CLIENT),
      SET_WORLD_CONTEXT: take(SET_ROOM_CONNECTION),
      timeout: delay(SEND_STATUS_INTERVAL_MILLIS)
    })

    const client: SocialAPI | null = yield select(getSocialClient)
    const realmConnectionString: string = yield select(getRealmConnectionString)
    const position: ReadOnlyVector2 = yield select(getParcelPosition)

    if (!client || realmConnectionString === OFFLINE_REALM) {
      continue
    }

    const rawFriends: string[] = yield select(getPrivateMessagingFriends)

    const friends = rawFriends.map((x) => getMatrixIdFromUser(x))

    updateUserStatus(client, ...friends)

    const updateStatus: UpdateUserStatus = {
      realm: {
        layer: '',
        serverName: realmConnectionString
      },
      position,
      presence: PresenceType.ONLINE
    }

    const shouldSendNewStatus = !deepEqual(updateStatus, lastStatus)

    if (shouldSendNewStatus) {
      logger.log('Sending new comms status', updateStatus)
      client.setStatus(updateStatus).catch((e) => logger.error(`error while setting status`, e))
      lastStatus = updateStatus
    }
  }
}

/**
 * The social id for the time being should always be of the form `@ethAddress:server`
 *
 * @param socialId a string with the aforementioned pattern
 */

function parseUserId(socialId: string) {
  if (EthAddress.validate(socialId) as any) return socialId
  const result = socialId.match(/@(\w+):.*/)
  if (!result || result.length < 2) {
    logger.warn(`Could not match social id with ethereum address, this should not happen`)
    return null
  }
  return result[1]
}

function addNewChatMessage(chatMessage: ChatMessage) {
  getUnityInstance().AddMessageToChatWindow(chatMessage)
}

function* handleSendChannelMessage(action: SendChannelMessage) {
  const { message, channelId } = action.payload

  const client: SocialAPI | null = yield select(getSocialClient)

  if (!client) {
    logger.error(`Social client should be initialized by now`)
    return
  }

  try {
    const conversation: Conversation | undefined = yield apply(client, client.getChannel, [channelId])
    if (conversation) {
      const messageId = yield apply(client, client.sendMessageTo, [conversation.id, message.body])

      if (messageId) {
        message.messageId = messageId
      }
      getUnityInstance().AddMessageToChatWindow(message)
    }
  } catch (e: any) {
    logger.error(e)
    trackEvent('error', {
      context: 'handleSendChannelMessage',
      message: e.message,
      stack: e.stack,
      saga_stack: e.toString()
    })
  }
}

function* handleSendPrivateMessage(action: SendPrivateMessage) {
  const { message, userId } = action.payload

  const client: SocialAPI | null = yield select(getSocialClient)

  if (!client) {
    logger.error(`Social client should be initialized by now`)
    return
  }

  const userData: ReturnType<typeof findPrivateMessagingFriendsByUserId> = yield select(
    findPrivateMessagingFriendsByUserId,
    userId
  )

  if (!userData) {
    logger.error(`User not found ${userId}`)
    return
  }

  try {
    const conversation: Conversation = yield apply(client, client.createDirectConversation, [userData.socialId])
    const messageId = yield apply(client, client.sendMessageTo, [conversation.id, message.body])
    if (messageId) {
      message.messageId = messageId
    }
    getUnityInstance().AddMessageToChatWindow(message)
  } catch (e: any) {
    logger.error(e)
    trackEvent('error', {
      context: 'handleSendPrivateMessage',
      message: e.message,
      stack: e.stack,
      saga_stack: e.toString()
    })
  }
}

function* handleUpdateFriendship({ payload, meta }: UpdateFriendship) {
  const { action, userId } = payload

  const client: SocialAPI | undefined = yield select(getSocialClient)

  if (!client) {
    return
  }

  try {
    const state: ReturnType<typeof getPrivateMessaging> = yield select(getPrivateMessaging)

    let newState: FriendsState | undefined

    const socialData: SocialData | undefined = yield select(findPrivateMessagingFriendsByUserId, userId)

    if (socialData) {
      try {
        yield apply(client, client.createDirectConversation, [socialData.socialId])
      } catch (e) {
        logAndTrackError('Error while creating direct conversation for friendship', e)
        return
      }
    } else {
      // if this is the case, a previous call to ensure data load is missing, this is an issue on our end
      logger.error(`handleUpdateFriendship, user not loaded`, userId)
      return
    }

    const incoming = meta.incoming
    const hasSentFriendshipRequest = state.toFriendRequests.some((request) => request.userId === userId)

    const friendRequestTypeSelector = hasSentFriendshipRequest ? 'toFriendRequests' : 'fromFriendRequests'
    const updateTotalFriendRequestsPayloadSelector: keyof UpdateTotalFriendRequestsPayload = hasSentFriendshipRequest
      ? 'totalSentRequests'
      : 'totalReceivedRequests'

    let updateTotalFriendRequestsPayload: UpdateTotalFriendRequestsPayload = yield select(getTotalFriendRequests)
    let totalFriends: number = yield select(getTotalFriends)

    switch (action) {
      case FriendshipAction.NONE: {
        // do nothing
        break
      }
      case FriendshipAction.APPROVED: {
        totalFriends += 1
      }
      // The approved should not have a break since it should execute all the code as the rejected case
      // Also the rejected needs to be directly after the Approved to make sure this works
      case FriendshipAction.REJECTED: {
        const requests = [...state[friendRequestTypeSelector]]

        const index = requests.findIndex((request) => request.userId === userId)

        logger.info(`requests[${friendRequestTypeSelector}]`, requests, index, userId)
        if (index !== -1) {
          requests.splice(index, 1)

          newState = { ...state, [friendRequestTypeSelector]: requests }

          if (action === FriendshipAction.APPROVED && !state.friends.includes(userId)) {
            newState.friends.push(userId)

            const socialData: SocialData = yield select(findPrivateMessagingFriendsByUserId, userId)
            try {
              const conversation: Conversation = yield client.createDirectConversation(socialData.socialId)

              logger.info(`userData`, userId, socialData.socialId, conversation.id)
              newState.socialInfo[userId] = { userId, socialId: socialData.socialId, conversationId: conversation.id }
            } catch (e) {
              logAndTrackError('Error while approving/rejecting friendship', e)
            }
          }
        }

        updateTotalFriendRequestsPayload = {
          ...updateTotalFriendRequestsPayload,
          [updateTotalFriendRequestsPayloadSelector]:
            updateTotalFriendRequestsPayload[updateTotalFriendRequestsPayloadSelector] - 1
        }

        break
      }

      case FriendshipAction.CANCELED: {
        const requests = [...state[friendRequestTypeSelector]]

        const index = requests.findIndex((request) => request.userId === userId)

        if (index !== -1) {
          requests.splice(index, 1)

          newState = { ...state, [friendRequestTypeSelector]: requests }
        }

        updateTotalFriendRequestsPayload = {
          ...updateTotalFriendRequestsPayload,
          [updateTotalFriendRequestsPayloadSelector]:
            updateTotalFriendRequestsPayload[updateTotalFriendRequestsPayloadSelector] - 1
        }

        break
      }
      case FriendshipAction.REQUESTED_FROM: {
        const request = state.fromFriendRequests.find((request) => request.userId === userId)

        if (!request) {
          newState = {
            ...state,
            fromFriendRequests: [...state.fromFriendRequests, { createdAt: Date.now(), userId }]
          }
        }

        updateTotalFriendRequestsPayload = {
          ...updateTotalFriendRequestsPayload,
          totalReceivedRequests: updateTotalFriendRequestsPayload.totalReceivedRequests + 1
        }

        break
      }
      case FriendshipAction.REQUESTED_TO: {
        const request = state.toFriendRequests.find((request) => request.userId === userId)

        if (!request) {
          newState = {
            ...state,
            toFriendRequests: [...state.toFriendRequests, { createdAt: Date.now(), userId }]
          }
        }

        updateTotalFriendRequestsPayload = {
          ...updateTotalFriendRequestsPayload,
          totalSentRequests: updateTotalFriendRequestsPayload.totalSentRequests + 1
        }

        break
      }
      case FriendshipAction.DELETED: {
        const index = state.friends.indexOf(userId)

        if (index !== -1) {
          const friends = [...state.friends]
          friends.splice(index, 1)

          newState = { ...state, friends }
        }

        totalFriends -= 1

        break
      }
    }

    getUnityInstance().UpdateTotalFriendRequests(updateTotalFriendRequestsPayload)
    getUnityInstance().UpdateTotalFriends({
      totalFriends
    })

    if (newState) {
      yield put(updatePrivateMessagingState(newState))

      if (incoming) {
        yield call(waitForRendererInstance)
      } else {
        yield call(handleOutgoingUpdateFriendshipStatus, payload)
      }

      getUnityInstance().UpdateFriendshipStatus(payload)
    }

    if (!incoming) {
      // refresh self & renderer friends status if update was triggered by renderer
      yield call(refreshFriends)
    }
  } catch (e) {
    if (e instanceof UnknownUsersError) {
      const profile: Avatar | undefined = yield call(ensureFriendProfile, userId)
      const id = profile?.name ? profile.name : `with address '${userId}'`
      showErrorNotification(`User ${id} must log in at least once before befriending them`)
    }

    // in case of any error, re initialize friends, to possibly correct state in both kernel and renderer
    yield call(refreshFriends)
  }
}

function* trackEvents({ payload }: UpdateFriendship) {
  const { action } = payload
  switch (action) {
    case FriendshipAction.APPROVED: {
      trackEvent('Control Friend request approved', {})
      break
    }
    case FriendshipAction.REJECTED: {
      trackEvent('Control Friend request rejected', {})
      break
    }
    case FriendshipAction.CANCELED: {
      trackEvent('Control Friend request cancelled', {})
      break
    }
    case FriendshipAction.REQUESTED_FROM: {
      trackEvent('Control Friend request received', {})
      break
    }
    case FriendshipAction.REQUESTED_TO: {
      trackEvent('Control Friend request sent', {})
      break
    }
    case FriendshipAction.DELETED: {
      trackEvent('Control Friend deleted', {})
      break
    }
  }
}

function showErrorNotification(message: string) {
  getUnityInstance().ShowNotification({
    type: NotificationType.GENERIC,
    message,
    buttonMessage: 'OK',
    timer: 5
  })
}

function* handleOutgoingUpdateFriendshipStatus(update: UpdateFriendship['payload']) {
  const client: SocialAPI | undefined = yield select(getSocialClient)
  const socialData: SocialData = yield select(findPrivateMessagingFriendsByUserId, update.userId)

  if (!client) {
    return
  }

  if (!socialData) {
    logger.error(`could not find social data for`, update.userId)
    return
  }

  const { socialId } = socialData

  try {
    switch (update.action) {
      case FriendshipAction.NONE: {
        // do nothing in this case
        // this action should never happen
        break
      }
      case FriendshipAction.APPROVED: {
        yield client.approveFriendshipRequestFrom(socialId)
        updateUserStatus(client, socialId)
        break
      }
      case FriendshipAction.REJECTED: {
        yield client.rejectFriendshipRequestFrom(socialId)
        break
      }
      case FriendshipAction.CANCELED: {
        yield client.cancelFriendshipRequestTo(socialId)
        break
      }
      case FriendshipAction.REQUESTED_FROM: {
        // do nothing in this case
        break
      }
      case FriendshipAction.REQUESTED_TO: {
        yield client.addAsFriend(socialId)
        break
      }
      case FriendshipAction.DELETED: {
        yield client.deleteFriendshipWith(socialId)
        break
      }
    }
  } catch (e) {
    logAndTrackError('error while acting user friendship action', e)
  }

  // wait for matrix server to process new status
  yield delay(500)
}

function toSocialData(socialIds: string[]) {
  return socialIds
    .map((socialId) => ({
      userId: parseUserId(socialId),
      socialId
    }))
    .filter(({ userId }) => !!userId) as SocialData[]
}

function logAndTrackError(message: string, e: any) {
  logger.error(message, e)

  trackEvent('error', {
    context: 'kernel#saga',
    message: message,
    stack: '' + e
  })
}

/**
 * Get the conversation id from the store when possible.
 * If not, then fetch it from matrix and update the private messaging state
 * @param client SocialAPI client
 * @param userId a string with the userId pattern
 */
async function getConversationId(client: SocialAPI, userId: string) {
  let conversationId = findPrivateMessagingFriendsByUserId(store.getState(), userId)?.conversationId

  if (!conversationId) {
    const socialId = getMatrixIdFromUser(userId)
    const conversation: Conversation = await client.createDirectConversation(socialId)

    const socialData: SocialData = {
      userId: userId,
      socialId: socialId,
      conversationId: conversation.id
    }

    updateSocialInfo(socialData)
    conversationId = conversation.id
  }

  return conversationId
}

/**
 * Update the social info from the private messaging state
 * @param socialData the social data to add to the record.
 */
function updateSocialInfo(socialData: SocialData) {
  const friends: FriendsState = getPrivateMessaging(store.getState())

  // add social info
  friends.socialInfo[socialData.socialId] = socialData

  put(
    updatePrivateMessagingState({
      ...friends
    })
  )
}

function* handleLeaveChannel(action: LeaveChannel) {
  try {
    const client = getSocialClient(store.getState())
    if (!client) return

    const channelId = action.payload.channelId
    yield apply(client, client.leaveChannel, [channelId])

    const profile = getCurrentUserProfile(store.getState())
    // if channel is muted, let's reset that config
    if (profile?.muted?.includes(channelId)) {
      store.dispatch(unmutePlayers([channelId]))
    }
  } catch (e) {
    notifyLeaveChannelError(action.payload.channelId, ChannelErrorCode.UNKNOWN)
  }
}

// Join or create channel
function* handleJoinOrCreateChannel(action: JoinOrCreateChannel) {
  try {
    const client: SocialAPI | null = getSocialClient(store.getState())
    if (!client) return

    const channelId = action.payload.channelId.toLowerCase()

    const reachedLimit = checkChannelsLimit()
    if (reachedLimit) {
      notifyJoinChannelError(channelId, ChannelErrorCode.LIMIT_EXCEEDED)
      return
    }

    // check if the user has perms to create channels.
    const isAllowed = isAllowedToCreate()
    if (isAllowed) {
      const { created, conversation }: GetOrCreateConversationResponse = yield apply(
        client,
        client.getOrCreateChannel,
        [channelId, []]
      )

      const channel: ChannelInfoPayload = {
        name: channelId,
        channelId: conversation.id,
        unseenMessages: 0,
        lastMessageTimestamp: undefined,
        memberCount: 1,
        description: '',
        joined: true,
        muted: false
      }

      if (created) {
        getUnityInstance().JoinChannelConfirmation({ channelInfoPayload: [channel] })
      } else {
        yield apply(client, client.joinChannel, [conversation.id])
      }
      // if the user does not have perms to create, we check if the channel exists and join if so.
    } else {
      const channelByName = yield apply(client, client.getChannelByName, [channelId])

      if (channelByName) {
        yield apply(client, client.joinChannel, [channelByName.id])
      } else {
        getUnityInstance().AddMessageToChatWindow({
          messageType: ChatMessageType.SYSTEM,
          messageId: uuid(),
          sender: 'Decentraland',
          body: `Ups, sorry! It seems you don't have permissions to create a channel.`,
          timestamp: Date.now()
        })
      }
    }
  } catch (e) {
    if (e instanceof ChannelsError) {
      let errorCode = ChannelErrorCode.UNKNOWN
      if (e.getKind() === ChannelErrorKind.BAD_REGEX) {
        errorCode = ChannelErrorCode.WRONG_FORMAT
      } else if (e.getKind() === ChannelErrorKind.RESERVED_NAME) {
        errorCode = ChannelErrorCode.RESERVED_NAME
      }
      notifyJoinChannelError(action.payload.channelId, errorCode)
    }
  }
}

// Join channel
export async function joinChannel(request: JoinOrCreateChannelPayload) {
  try {
    const client: SocialAPI | null = getSocialClient(store.getState())
    if (!client) return

    const channelId = request.channelId

    const reachedLimit = checkChannelsLimit()
    if (reachedLimit) {
      notifyJoinChannelError(channelId, ChannelErrorCode.LIMIT_EXCEEDED)
      return
    }

    await client.joinChannel(channelId)
  } catch (e) {
    notifyJoinChannelError(request.channelId, ChannelErrorCode.UNKNOWN)
  }
}

// Create channel
export async function createChannel(request: CreateChannelPayload) {
  try {
    const channelId = request.channelId

    const reachedLimit = checkChannelsLimit()
    if (reachedLimit) {
      notifyJoinChannelError(channelId, ChannelErrorCode.LIMIT_EXCEEDED)
      return
    }

    const client: SocialAPI | null = getSocialClient(store.getState())
    if (!client) return

    // create channel
    const { conversation, created } = await client.getOrCreateChannel(channelId, [])

    // if it already exists, we notify an error
    if (!created) {
      notifyJoinChannelError(request.channelId, ChannelErrorCode.ALREADY_EXISTS)
      return
    }

    const channel: ChannelInfoPayload = {
      name: conversation.name ?? request.channelId,
      channelId: conversation.id,
      unseenMessages: 0,
      lastMessageTimestamp: undefined,
      memberCount: 1,
      description: '',
      joined: true,
      muted: false
    }

    getUnityInstance().JoinChannelConfirmation({ channelInfoPayload: [channel] })
  } catch (e) {
    if (e instanceof ChannelsError) {
      let errorCode = ChannelErrorCode.UNKNOWN
      if (e.getKind() === ChannelErrorKind.BAD_REGEX) {
        errorCode = ChannelErrorCode.WRONG_FORMAT
      } else if (e.getKind() === ChannelErrorKind.RESERVED_NAME) {
        errorCode = ChannelErrorCode.RESERVED_NAME
      }
      notifyJoinChannelError(request.channelId, errorCode)
    }
  }
}

// Get unseen messages by channel
export function getUnseenMessagesByChannel() {
  // get conversations messages
  const updateTotalUnseenMessagesByChannelPayload: UpdateTotalUnseenMessagesByChannelPayload =
    getTotalUnseenMessagesByChannel()

  // send total unseen messages by channels to unity
  getUnityInstance().UpdateTotalUnseenMessagesByChannel(updateTotalUnseenMessagesByChannelPayload)
}

// Get user's joined channels
export function getJoinedChannels(request: GetJoinedChannelsPayload) {
  const client = getSocialClient(store.getState())
  if (!client) return []

  // get user joined channels
  const joinedChannels = getChannels(store.getState())

  const conversationsFiltered = joinedChannels.slice(request.skip, request.skip + request.limit)

  const profile = getCurrentUserProfile(store.getState())

  const channelsToReturn: ChannelInfoPayload[] = conversationsFiltered.map((conv) => ({
    name: conv.conversation.name || '',
    channelId: conv.conversation.id,
    unseenMessages: conv.conversation.unreadMessages?.length || 0,
    lastMessageTimestamp: conv.conversation.lastEventTimestamp || undefined,
    memberCount: getOnlineMembersCount(client, conv.conversation.userIds),
    description: '',
    joined: true,
    muted: profile?.muted?.includes(conv.conversation.id) ?? false
  }))

  getUnityInstance().UpdateChannelInfo({ channelInfoPayload: channelsToReturn })
}

// Mark channel messages as seen
export async function markAsSeenChannelMessages(request: MarkChannelMessagesAsSeenPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  const ownId = client.getUserId()

  // get user's chat unread messages
  const unreadMessages = client.getConversationUnreadMessages(request.channelId).length

  if (unreadMessages > 0) {
    // mark as seen all the messages in the conversation
    await client.markMessagesAsSeen(request.channelId)
  }

  // get total user unread messages
  const totalUnreadMessages = getTotalUnseenMessages(client, ownId, getFriendIds(client))
  const updateTotalUnseenMessages: UpdateTotalUnseenMessagesPayload = {
    total: totalUnreadMessages
  }

  // get total unseen messages by channel
  const updateTotalUnseenMessagesByChannel: UpdateTotalUnseenMessagesByChannelPayload =
    getTotalUnseenMessagesByChannel()

  getUnityInstance().UpdateTotalUnseenMessagesByChannel(updateTotalUnseenMessagesByChannel)
  getUnityInstance().UpdateTotalUnseenMessages(updateTotalUnseenMessages)
}

// Get channel messages
export async function getChannelMessages(request: GetChannelMessagesPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  // get cursor of the conversation located on the given message or at the end of the conversation if there is no given message.
  const messageId: string | undefined = !request.from ? undefined : request.from

  // the message in question is in the middle of a window, so we multiply by two the limit in order to get the required messages.
  let limit = request.limit
  if (messageId !== undefined) {
    limit = limit * 2
  }

  const cursorMessage = await client.getCursorOnMessage(request.channelId, messageId, {
    initialSize: limit,
    limit
  })

  if (!cursorMessage) return

  // get list of messages currently in the window with the oldest event at index 0
  const messages = cursorMessage.getMessages()
  if (messageId !== undefined) {
    // we remove the messages they already have.
    const index = messages.map((messages) => messages.id).indexOf(messageId)
    messages.splice(index)
  }
  const ownId = client.getUserId()

  // deduplicate sender IDs
  const senderIds = Array.from(new Set(messages.map((message) => message.sender)))

  // get members from user IDs
  const members = getMembers(client, senderIds, request.channelId)

  // update catalog with missing users, by using default profiles with name and image url
  sendMissingProfiles(members, ownId)

  const addChatMessages: AddChatMessagesPayload = {
    messages: []
  }

  for (const message of messages) {
    const sender = getUserIdFromMatrix(message.sender)

    addChatMessages.messages.push({
      messageId: message.id,
      messageType: ChatMessageType.PUBLIC,
      timestamp: message.timestamp,
      body: message.text,
      sender,
      senderName: members.find((member) => member.userId === sender)?.name,
      recipient: request.channelId
    })
  }

  getUnityInstance().AddChatMessages(addChatMessages)
}

function findMissingMembers(members: ChannelMember[], ownId: string) {
  return members.filter((member) => {
    const localUserId = getUserIdFromMatrix(member.userId)
    return member.userId !== ownId && !isAddedToCatalog(store.getState(), localUserId)
  })
}

function getMembers(client: SocialAPI, userIds: string[], channelId: string) {
  return userIds.map((userId): ChannelMember => {
    const memberInfo = client.getMemberInfo(channelId, userId)
    return { userId, name: memberInfo.displayName ?? '' }
  })
}

// Search channels
export async function searchChannels(request: GetChannelsPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  const searchTerm = request.name === '' ? undefined : request.name
  const since: string | undefined = request.since === '' ? undefined : request.since

  // get user joined channelIds
  const joinedChannelIds = getChannels(store.getState()).map((conv) => conv.conversation.id)

  const profile = getCurrentUserProfile(store.getState())

  // search channels
  const { channels, nextBatch } = await client.searchChannel(request.limit, searchTerm, since)

  const channelsToReturn: ChannelInfoPayload[] = channels
    .filter((channel) => channel.name?.includes(searchTerm ?? ''))
    .map((channel) => ({
      channelId: channel.id,
      name: channel.name || '',
      unseenMessages: 0,
      lastMessageTimestamp: undefined,
      memberCount: channel.memberCount,
      description: channel.description || '',
      joined: joinedChannelIds.includes(channel.id),
      muted: profile?.muted?.includes(channel.id) ?? false
    }))

  // sort in descending order by memberCount value
  const channelsSorted = channelsToReturn.sort((a, b) => (a.memberCount > b.memberCount ? -1 : 1))

  const searchResult: ChannelSearchResultsPayload = {
    since: nextBatch === undefined ? null : nextBatch,
    channels: channelsSorted
  }

  getUnityInstance().UpdateChannelSearchResults(searchResult)
}

/**
 * Send join/create channel related error message to unity
 * @param channelId
 * @param errorCode
 */
function notifyJoinChannelError(channelId: string, errorCode: number) {
  const joinChannelError: ChannelErrorPayload = {
    channelId,
    errorCode
  }

  // send error message to unity
  getUnityInstance().JoinChannelError(joinChannelError)
}

/**
 * Send leave channel related error message to unity
 * @param channelId
 */
function notifyLeaveChannelError(channelId: string, errorCode: ChannelErrorCode) {
  const leaveChannelError: ChannelErrorPayload = {
    channelId,
    errorCode
  }
  getUnityInstance().LeaveChannelError(leaveChannelError)
}

/**
 * Send mute/unmute channel related error message to unity
 * @param channelId
 */
function notifyMuteChannelError(channelId: string, errorCode: ChannelErrorCode) {
  const muteChannelError: ChannelErrorPayload = {
    channelId,
    errorCode
  }
  getUnityInstance().MuteChannelError(muteChannelError)
}

/**
 * Get list of total unseen messages by channelId
 */
function getTotalUnseenMessagesByChannel() {
  // get conversations messages
  const conversationsWithMessages = getChannels(store.getState())

  const updateTotalUnseenMessagesByChannelPayload: UpdateTotalUnseenMessagesByChannelPayload = {
    unseenChannelMessages: []
  }

  // it means the user is not joined to any channel or they're joined to channels without messages
  if (conversationsWithMessages.length === 0) {
    return updateTotalUnseenMessagesByChannelPayload
  }

  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) {
    return updateTotalUnseenMessagesByChannelPayload
  }

  // get muted channel ids
  const mutedIds = getCurrentUserProfile(store.getState())?.muted

  for (const conv of conversationsWithMessages) {
    // prevent from counting unread messages of muted channels
    updateTotalUnseenMessagesByChannelPayload.unseenChannelMessages.push({
      count: mutedIds?.includes(conv.conversation.id) ? 0 : conv.conversation.unreadMessages?.length || 0,
      channelId: conv.conversation.id
    })
  }

  return updateTotalUnseenMessagesByChannelPayload
}

// Enable / disable channel notifications
export function muteChannel(muteChannel: MuteChannelPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  const channelId = muteChannel.channelId

  const channel: Conversation | undefined = client.getChannel(channelId)
  if (!channel) {
    notifyMuteChannelError(channelId, ChannelErrorCode.UNKNOWN)
    return
  }

  // mute / unmute channel
  if (muteChannel.muted) {
    store.dispatch(mutePlayers([channelId]))
  } else {
    store.dispatch(unmutePlayers([channelId]))
  }

  const onlineMembers = getOnlineMembersCount(client, channel.userIds)

  const channelInfo: ChannelInfoPayload = {
    name: channel.name ?? '',
    channelId: channel.id,
    unseenMessages: channel.unreadMessages?.length ?? 0,
    lastMessageTimestamp: channel.lastEventTimestamp ?? undefined,
    memberCount: onlineMembers,
    description: '',
    joined: true,
    muted: muteChannel.muted
  }

  // send message to unity
  getUnityInstance().UpdateChannelInfo({ channelInfoPayload: [channelInfo] })
}

/**
 * Get the number of channels the user is joined to and check with a feature flag value if the user has reached the maximum amount allowed.
 * @return `true` if the user has reached the maximum amount allowed | `false` if it has not.
 */
function checkChannelsLimit() {
  const limit = getMaxChannels(store.getState())

  const joinedChannels = getChannels(store.getState()).length

  if (limit > joinedChannels) {
    return false
  }

  return true
}

// Get channel info
export function getChannelInfo(request: GetChannelInfoPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  // get notification settings
  const profile = getCurrentUserProfile(store.getState())
  const channels: ChannelInfoPayload[] = []

  for (const channelId of request.channelIds) {
    const channel = client.getChannel(channelId)
    if (!channel) continue

    const muted = profile?.muted?.includes(channelId) ?? false

    const onlineMembers = getOnlineMembersCount(client, channel.userIds)

    channels.push({
      name: getNormalizedRoomName(channel.name || ''),
      channelId: channel.id,
      unseenMessages: muted ? 0 : channel.unreadMessages?.length || 0,
      lastMessageTimestamp: channel.lastEventTimestamp || undefined,
      memberCount: onlineMembers,
      description: '',
      joined: true,
      muted
    })
  }
  getUnityInstance().UpdateChannelInfo({ channelInfoPayload: channels })
}

// Get channel members
export async function getChannelMembers(request: GetChannelMembersPayload) {
  const client: SocialAPI | null = getSocialClient(store.getState())
  if (!client) return

  const channel = client.getChannel(request.channelId)
  if (!channel) return

  const channelMembersPayload: UpdateChannelMembersPayload = {
    channelId: request.channelId,
    members: []
  }

  const members = getMembers(client, channel.userIds ?? [], request.channelId)
    .filter(({ name }) => {
      const searchTerm = request.userName.toLocaleLowerCase()
      const lowerCaseName = name.toLocaleLowerCase()
      return lowerCaseName.search(searchTerm) >= 0
    })
    .slice(request.skip, request.skip + request.limit)

  if (members.length === 0) {
    // it means the channel has no members
    getUnityInstance().UpdateChannelMembers(channelMembersPayload)
    return
  }

  const ownId = client.getUserId()

  // update catalog with missing users, by using default profiles with name and image url
  sendMissingProfiles(members, ownId)

  // we only notify members who are online
  const memberIds = members.map((member) => member.userId)
  const onlineMemberIds = getOnlineMembers(memberIds, client)

  const membersPayload = members
    .filter((member) => onlineMemberIds.includes(member.userId))
    .map((member) => ((member.userId = getUserIdFromMatrix(member.userId)), { ...member, isOnline: true }))

  channelMembersPayload.members.push(...membersPayload)

  getUnityInstance().UpdateChannelMembers(channelMembersPayload)
}

/**
 * TODO: This method should be removed once we implement the correct member resolution in Explorer
 * Checks which members are present in the profile catalog and sends partial profiles for missing users
 * @param members is an array of [member ID, name]
 */
function sendMissingProfiles(members: ChannelMember[], ownId: string) {
  // find missing users
  const missingUsers = findMissingMembers(members, ownId)

  if (missingUsers.length > 0) {
    const missingProfiles = getMissingProfiles(missingUsers)
    getUnityInstance().AddUserProfilesToCatalog({ users: missingProfiles })
  }
}

// TODO: This method should be removed once we implement the correct member resolution in Explorer
function getMissingProfiles(missingUsers: ChannelMember[]): NewProfileForRenderer[] {
  return missingUsers.map((missingUser) => buildMissingProfile(missingUser))
}

// TODO: This method should be removed once we implement the correct member resolution in Explorer
function buildMissingProfile(user: ChannelMember) {
  const localpart = getUserIdFromMatrix(user.userId)
  return defaultProfile({
    userId: localpart,
    name: user.name,
    face256: buildProfilePictureURL(localpart)
  })
}

// TODO: This method should be removed once we implement the correct member resolution in Explorer
function buildProfilePictureURL(userId: string): string {
  const synapseUrl = getSynapseUrl(store.getState())
  return `${synapseUrl}/profile-pictures/${userId}`
}

/**
 * Check with a feature flag value if the user is allowed to create channels.
 * @return `true` if the user is allowed | `false` if it is not.
 */
function isAllowedToCreate() {
  const allowedUsers = getUsersAllowedToCreate(store.getState())
  const ownId = getCurrentUserId(store.getState())

  if (!allowedUsers || !ownId || allowedUsers.mode !== 0) {
    return false
  }

  if (allowedUsers.allowList.includes(ownId)) {
    return true
  }
}

/**
 * Filter members online from a given list of user ids.
 * @return `string[]` with the ids of the members who are online.
 */
function getOnlineMembers(userIds: string[], client: SocialAPI): string[] {
  const userStatuses = client.getUserStatuses(...userIds)
  const onlineMembers = userIds.filter((id) => userStatuses.get(id)?.presence === PresenceType.ONLINE)

  return onlineMembers
}

function getOnlineMembersCount(client: SocialAPI, userIds?: string[]): number {
  if (!userIds) return 0

  return getOnlineMembers(userIds, client).length
}
