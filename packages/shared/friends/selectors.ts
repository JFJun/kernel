import { Conversation, ConversationType } from 'dcl-social-client'
import { UpdateTotalFriendRequestsPayload } from 'shared/types'
import { RootFriendsState } from './types'
import { getUserIdFromMatrix } from './utils'

export const getSocialClient = (store: RootFriendsState) => store.friends.client

/**
 * Get all conversations `ConversationType.CHANNEL` that the user has
 * @return `conversation` & `unreadMessages` boolean that indicates whether the chat has unread messages.
 */
export const getChannels = (
  store: RootFriendsState
): Array<{ conversation: Conversation; unreadMessages: boolean }> => {
  return getConversations(store, ConversationType.CHANNEL)
}

/**
 * Get all current conversations the user has including DMs, channels, etc
 * @return `conversation` & `unreadMessages` boolean that indicates whether the conversation has unread messages.
 */
export const getConversations = (
  store: RootFriendsState,
  conversationType: ConversationType
): Array<{ conversation: Conversation; unreadMessages: boolean }> => {
  const client = getSocialClient(store)
  if (!client) return []

  const conversations = client.getAllCurrentConversations()
  return conversations
    .filter((conv) => conv.conversation.type === conversationType)
    .map((conv) => ({
      ...conv,
      conversation: {
        ...conv.conversation,
        userIds: conv.conversation.userIds?.map((userId) => getUserIdFromMatrix(userId))
      }
    }))
}

/**
 * Get all current conversations with messages the user has including DMs, channels, etc
 * @return `conversation` & `unreadMessages` boolean that indicates whether the conversation has unread messages.
 */
export const getAllConversationsWithMessages = (
  store: RootFriendsState
): Array<{ conversation: Conversation; unreadMessages: boolean }> => {
  const client = getSocialClient(store)
  if (!client) return []

  const conversations = client.getAllCurrentConversations()

  return conversations
    .filter((conv) => conv.conversation.hasMessages)
    .map((conv) => ({
      ...conv,
      conversation: {
        ...conv.conversation,
        userIds: conv.conversation.userIds?.map((userId) => getUserIdFromMatrix(userId))
      }
    }))
}

/**
 * Get all conversations `ConversationType.DIRECT` with friends the user has befriended
 * @return `conversation` & `unreadMessages` boolean that indicates whether the conversation has unread messages.
 */
export const getAllFriendsConversationsWithMessages = (
  store: RootFriendsState
): Array<{ conversation: Conversation; unreadMessages: boolean }> => {
  const client = getSocialClient(store)
  if (!client) return []

  const conversations = client.getAllCurrentFriendsConversations()

  return conversations
    .filter((conv) => conv.conversation.hasMessages)
    .map((conv) => ({
      ...conv,
      conversation: {
        ...conv.conversation,
        userIds: conv.conversation.userIds?.map((userId) => getUserIdFromMatrix(userId))
      }
    }))
}

export const getTotalFriendRequests = (store: RootFriendsState): UpdateTotalFriendRequestsPayload => ({
  totalReceivedRequests: store.friends.fromFriendRequests.length,
  totalSentRequests: store.friends.toFriendRequests.length
})

export const getTotalFriends = (store: RootFriendsState): number => store.friends.friends.length

export const getPrivateMessaging = (store: RootFriendsState) => store.friends
export const getPrivateMessagingFriends = (store: RootFriendsState): string[] => store.friends?.friends || []

export const findPrivateMessagingFriendsByUserId = (store: RootFriendsState, userId: string) =>
  Object.values(store.friends.socialInfo).find((socialData) => socialData.userId === userId)

export const isFriend = (store: RootFriendsState, userId: string) => store.friends.friends.includes(userId)

export const getLastStatusOfFriends = (store: RootFriendsState) => store.friends.lastStatusOfFriends
