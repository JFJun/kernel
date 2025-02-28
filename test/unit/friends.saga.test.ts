import { buildStore } from 'shared/store/store'
import {
  AddChatMessagesPayload,
  ChatMessageType,
  AddFriendsWithDirectMessagesPayload,
  GetFriendRequestsPayload,
  GetFriendsPayload,
  GetFriendsWithDirectMessagesPayload,
  GetPrivateMessagesPayload,
  PresenceStatus
} from 'shared/types'
import sinon from 'sinon'
import * as friendsSagas from '../../packages/shared/friends/sagas'
import { setMatrixClient } from 'shared/friends/actions'
import * as friendsSelectors from 'shared/friends/selectors'
import * as profilesSelectors from 'shared/profiles/selectors'
import { ProfileUserInfo } from 'shared/profiles/types'
import { getUnityInstance, setUnityInstance } from '../../packages/unity-interface/IUnityInterface'
import { profileToRendererFormat } from 'shared/profiles/transformations/profileToRendererFormat'
import { FriendRequest, FriendsState } from 'shared/friends/types'
import {
  Conversation,
  ConversationType,
  CurrentUserStatus,
  MessageStatus,
  PresenceType,
  SocialAPI,
  TextMessage
} from 'dcl-social-client'
import { AddUserProfilesToCatalogPayload } from 'shared/profiles/transformations/types'
import * as realmSelectors from 'shared/realm/selectors'
import * as sceneLoaderSelectors from 'shared/scene-loader/selectors'
import { expectSaga } from 'redux-saga-test-plan'
import { select } from 'redux-saga/effects'
import { getRealmConnectionString } from 'shared/realm/selectors'

function getMockedAvatar(userId: string, name: string): ProfileUserInfo {
  return {
    data: {
      avatar: {
        snapshots: {
          face256: '',
          body: ''
        },
        eyes: { color: '' },
        hair: { color: '' },
        skin: { color: '' }
      } as any,
      description: '',
      ethAddress: userId,
      hasClaimedName: false,
      name,
      tutorialStep: 1,
      userId,
      version: 1
    },
    status: 'ok'
  }
}

const textMessages: TextMessage[] = [
  {
    id: '1',
    timestamp: Date.now(),
    text: 'Hi there, how are you?',
    sender: '0xa2',
    status: MessageStatus.READ
  },
  {
    id: '2',
    timestamp: Date.now(),
    text: 'Hi, it is all good',
    sender: '0xa3',
    status: MessageStatus.READ
  }
]

const friendIds = ['0xa1', '0xb1', '0xc1', '0xd1']

const fromFriendRequest: FriendRequest = {
  userId: '0xa1',
  createdAt: 123123132
}

const toFriendRequest: FriendRequest = {
  userId: '0xa2',
  createdAt: 123123132
}

const lastStatusOfFriendsEntries = [
  [
    '@0xa1:decentraland.org',
    {
      realm: {
        layer: '',
        serverName: 'serverTest'
      },
      position: { x: 0, y: 1 },
      presence: PresenceType.ONLINE,
      lastActiveAgo: 1
    }
  ]
] as const

const lastStatusOfFriends = new Map<string, CurrentUserStatus>(lastStatusOfFriendsEntries)

const friendsFromStore: FriendsState = {
  client: null,
  socialInfo: {},
  friends: [],
  fromFriendRequests: [fromFriendRequest],
  toFriendRequests: [toFriendRequest],
  lastStatusOfFriends: new Map()
}

const profilesFromStore = [
  getMockedAvatar('0xa1', 'john'),
  getMockedAvatar('0xa2', 'mike'),
  getMockedAvatar('0xc1', 'agus'),
  getMockedAvatar('0xd1', 'boris')
]

const getMockedConversation = (userIds: string[]): Conversation => ({
  type: ConversationType.DIRECT,
  id: userIds.join('-'),
  userIds,
  lastEventTimestamp: Date.now(),
  hasMessages: true
})

const allCurrentConversations: Array<{ conversation: Conversation; unreadMessages: boolean }> = [
  {
    conversation: getMockedConversation([profilesFromStore[0].data.userId, profilesFromStore[1].data.userId]),
    unreadMessages: false
  },
  {
    conversation: getMockedConversation([profilesFromStore[0].data.userId, profilesFromStore[2].data.userId]),
    unreadMessages: false
  },
  {
    conversation: getMockedConversation([profilesFromStore[0].data.userId, profilesFromStore[3].data.userId]),
    unreadMessages: false
  }
]

const stubClient = {
  getAllCurrentConversations: () => allCurrentConversations,
  getAllCurrentFriendsConversations: () => allCurrentConversations,
  getCursorOnMessage: () => Promise.resolve({ getMessages: () => textMessages }),
  getUserId: () => '0xa2',
  createDirectConversation: () => allCurrentConversations[0].conversation,
  getUserStatuses: (...friendIds: string[]) => {
    const m = new Map()
    for (const id of friendIds) {
      const status = lastStatusOfFriends.get(id)
      if (status) {
        m.set(id, status)
      }
    }
    return m
  },
  setStatus: () => Promise.resolve()
} as unknown as SocialAPI

const FETCH_CONTENT_SERVER = 'base-url'

function mockStoreCalls(
  opts?: { profiles: number[]; i: number },
  fakeLastStatusOfFriends?: Map<string, CurrentUserStatus>
) {
  sinon.stub(realmSelectors, 'ensureRealmAdapterPromise').callsFake(async () => ({} as any))
  sinon.stub(realmSelectors, 'getFetchContentUrlPrefixFromRealmAdapter').callsFake(() => FETCH_CONTENT_SERVER)
  sinon.stub(friendsSelectors, 'getPrivateMessagingFriends').callsFake(() => friendIds)
  sinon.stub(sceneLoaderSelectors, 'getParcelPosition').callsFake(() => ({ x: 1, y: 2 }))
  sinon.stub(friendsSelectors, 'getPrivateMessaging').callsFake(() => friendsFromStore)
  sinon
    .stub(profilesSelectors, 'getProfilesFromStore')
    .callsFake((_, _userIds, userNameOrId) =>
      profilesSelectors.filterProfilesByUserNameOrId(profilesFromStore.slice(0, opts?.profiles[opts.i]), userNameOrId)
    )
  sinon.stub(friendsSelectors, 'getSocialClient').callsFake(() => stubClient)
  sinon
    .stub(friendsSelectors, 'getLastStatusOfFriends')
    .callsFake(() => fakeLastStatusOfFriends || friendsFromStore.lastStatusOfFriends)

  // here we list all the functions that should be invoked by this tests
  setUnityInstance({
    AddUserProfilesToCatalog() {},
    AddFriends() {},
    UpdateUserPresence() {},
    AddFriendsWithDirectMessages() {},
    AddFriendRequests() {},
    AddChatMessages() {},
    UpdateChannelInfo() {},
    UpdateTotalUnseenMessagesByChannel() {},
    UpdateChannelSearchResults() {}
  } as any)
}

describe('Friends sagas', () => {
  sinon.mock()

  describe('get friends', () => {
    beforeEach(() => {
      const { store } = buildStore()
      globalThis.globalStore = store

      mockStoreCalls()
    })

    afterEach(() => {
      sinon.restore()
      sinon.reset()
    })

    describe("When there's a filter by id", () => {
      it('Should filter the responses to have only the ones that include the userId and have the full friends length as total', async () => {
        const unityInstance = getUnityInstance()
        const unityMock = sinon.mock(unityInstance)
        const request: GetFriendsPayload = {
          limit: 1000,
          skip: 0,
          userNameOrId: '0xa'
        }
        const expectedFriends: AddUserProfilesToCatalogPayload = {
          users: [
            profileToRendererFormat(profilesFromStore[0].data, { baseUrl: FETCH_CONTENT_SERVER }),
            profileToRendererFormat(profilesFromStore[1].data, { baseUrl: FETCH_CONTENT_SERVER })
          ]
        }
        const addedFriends = {
          friends: expectedFriends.users.map((friend) => friend.userId),
          totalFriends: profilesFromStore.length
        }

        sinon.stub(unityInstance, 'UpdateUserPresence').callsFake(() => {}) // friendsSagas.getFriends update user presence internally
        unityMock.expects('AddUserProfilesToCatalog').once().withExactArgs(expectedFriends)
        unityMock.expects('AddFriends').once().withExactArgs(addedFriends)
        await friendsSagas.getFriends(request)
        unityMock.verify()
      })
    })

    describe("When there's a filter by name", () => {
      it('Should filter the responses to have only the ones that include the user name and have the full friends length as total', async () => {
        const request2: GetFriendsPayload = {
          limit: 1000,
          skip: 0,
          userNameOrId: 'MiKe'
        }
        const expectedFriends: AddUserProfilesToCatalogPayload = {
          users: [profileToRendererFormat(profilesFromStore[1].data, { baseUrl: FETCH_CONTENT_SERVER })]
        }
        const addedFriends = {
          friends: expectedFriends.users.map((friend) => friend.userId),
          totalFriends: profilesFromStore.length
        }
        sinon.mock(getUnityInstance()).expects('AddUserProfilesToCatalog').once().withExactArgs(expectedFriends)
        sinon.mock(getUnityInstance()).expects('AddFriends').once().withExactArgs(addedFriends)
        await friendsSagas.getFriends(request2)
        sinon.mock(getUnityInstance()).verify()
      })
    })

    describe("When there's a skip", () => {
      it('Should filter the responses to skip the expected amount', async () => {
        const request2: GetFriendsPayload = {
          limit: 1000,
          skip: 1
        }
        const expectedFriends: AddUserProfilesToCatalogPayload = {
          users: profilesFromStore
            .slice(1)
            .map((profile) => profileToRendererFormat(profile.data, { baseUrl: FETCH_CONTENT_SERVER }))
        }
        const addedFriends = {
          friends: expectedFriends.users.map((friend) => friend.userId),
          totalFriends: 4
        }
        sinon.mock(getUnityInstance()).expects('AddUserProfilesToCatalog').once().withExactArgs(expectedFriends)
        sinon.mock(getUnityInstance()).expects('AddFriends').once().withExactArgs(addedFriends)
        await friendsSagas.getFriends(request2)
        sinon.mock(getUnityInstance()).verify()
      })
    })
  })

  describe('get friend requests', () => {
    const opts = {
      profiles: [2, 0],
      i: 0
    }

    beforeEach(() => {
      const { store } = buildStore()
      globalThis.globalStore = store

      mockStoreCalls(opts)
    })

    afterEach(() => {
      opts.i = +1
      sinon.restore()
      sinon.reset()
    })

    describe("When there're sent and received friend requests", () => {
      it('Should call unity with the declared parameters', async () => {
        const request: GetFriendRequestsPayload = {
          sentLimit: 10,
          sentSkip: 0,
          receivedLimit: 10,
          receivedSkip: 0
        }

        const addedFriendRequests = {
          requestedTo: friendsFromStore.toFriendRequests.map((friend) => friend.userId),
          requestedFrom: friendsFromStore.fromFriendRequests.map((friend) => friend.userId),
          totalReceivedFriendRequests: friendsFromStore.fromFriendRequests.length,
          totalSentFriendRequests: friendsFromStore.toFriendRequests.length
        }

        const expectedFriends: AddUserProfilesToCatalogPayload = {
          users: [
            profileToRendererFormat(profilesFromStore[0].data, { baseUrl: FETCH_CONTENT_SERVER }),
            profileToRendererFormat(profilesFromStore[1].data, { baseUrl: FETCH_CONTENT_SERVER })
          ]
        }

        sinon.mock(getUnityInstance()).expects('AddUserProfilesToCatalog').once().withExactArgs(expectedFriends)
        sinon.mock(getUnityInstance()).expects('AddFriendRequests').once().withExactArgs(addedFriendRequests)
        await friendsSagas.getFriendRequests(request)
        sinon.mock(getUnityInstance()).verify()
      })
    })

    describe("When there're friend requests, but there's also a skip", () => {
      it('Should filter the requests to skip the expected amount', async () => {
        const request: GetFriendRequestsPayload = {
          sentLimit: 10,
          sentSkip: 5,
          receivedLimit: 10,
          receivedSkip: 5
        }

        const addedFriendRequests = {
          requestedTo: friendsFromStore.toFriendRequests.slice(5).map((friend) => friend.userId),
          requestedFrom: friendsFromStore.fromFriendRequests.slice(5).map((friend) => friend.userId),
          totalReceivedFriendRequests: friendsFromStore.fromFriendRequests.length,
          totalSentFriendRequests: friendsFromStore.toFriendRequests.length
        }

        const expectedFriends: AddUserProfilesToCatalogPayload = {
          users: profilesFromStore
            .slice(5)
            .map((profile) => profileToRendererFormat(profile.data, { baseUrl: FETCH_CONTENT_SERVER }))
        }

        sinon.mock(getUnityInstance()).expects('AddUserProfilesToCatalog').once().withExactArgs(expectedFriends)
        sinon.mock(getUnityInstance()).expects('AddFriendRequests').once().withExactArgs(addedFriendRequests)
        await friendsSagas.getFriendRequests(request)
        sinon.mock(getUnityInstance()).verify()
      })
    })
  })

  describe('getFriendsWithDirectMessages', () => {
    describe("when there's a client", () => {
      beforeEach(() => {
        const { store } = buildStore()
        globalThis.globalStore = store

        mockStoreCalls()
      })

      afterEach(() => {
        sinon.restore()
        sinon.reset()
      })

      it('Should send unity the expected profiles and the expected friend conversations', async () => {
        const unityInstance = getUnityInstance()
        const unityMock = sinon.mock(unityInstance)
        const request: GetFriendsWithDirectMessagesPayload = {
          limit: 1000,
          skip: 0,
          userNameOrId: '0xa' // this will only bring the friend 0xa2
        }
        const expectedFriends: AddUserProfilesToCatalogPayload = {
          users: [profileToRendererFormat(profilesFromStore[1].data, { baseUrl: FETCH_CONTENT_SERVER })]
        }

        const expectedAddFriendsWithDirectMessagesPayload: AddFriendsWithDirectMessagesPayload = {
          currentFriendsWithDirectMessages: [
            {
              lastMessageTimestamp: allCurrentConversations[0].conversation.lastEventTimestamp!,
              userId: profilesFromStore[1].data.userId
            }
          ],
          totalFriendsWithDirectMessages: allCurrentConversations.length
        }

        sinon.stub(unityInstance, 'UpdateUserPresence').callsFake(() => {}) // friendsSagas.getFriendsWithDirectMessages update user presence internally
        unityMock.expects('AddUserProfilesToCatalog').once().withExactArgs(expectedFriends)
        unityMock
          .expects('AddFriendsWithDirectMessages')
          .once()
          .withExactArgs(expectedAddFriendsWithDirectMessagesPayload)
        await friendsSagas.getFriendsWithDirectMessages(request)
        unityMock.verify()
      })
    })
  })

  describe('get private messages from specific chat', () => {
    describe('When a private chat is opened', () => {
      beforeEach(() => {
        const { store } = buildStore()
        globalThis.globalStore = store

        mockStoreCalls()
      })

      afterEach(() => {
        sinon.restore()
        sinon.reset()
      })

      it('Should call unity with the expected private messages', async () => {
        const request: GetPrivateMessagesPayload = {
          userId: '0xa3',
          limit: 10,
          fromMessageId: ''
        }

        // parse messages
        const addChatMessagesPayload: AddChatMessagesPayload = {
          messages: textMessages.map((message) => ({
            messageId: message.id,
            messageType: ChatMessageType.PRIVATE,
            timestamp: message.timestamp,
            body: message.text,
            sender: message.sender === '0xa2' ? '0xa2' : request.userId,
            recipient: message.sender === '0xa2' ? request.userId : '0xa2'
          }))
        }

        sinon.mock(getUnityInstance()).expects('AddChatMessages').once().withExactArgs(addChatMessagesPayload)
        await friendsSagas.getPrivateMessages(request)
        sinon.mock(getUnityInstance()).verify()
      })
    })
  })

  describe('update friends status', () => {
    beforeEach(() => {
      const { store } = buildStore()
      globalThis.globalStore = store
    })

    afterEach(() => {
      sinon.restore()
      sinon.reset()
    })

    it("should send status when it's not stored in the redux state yet", async () => {
      mockStoreCalls(undefined, new Map()) // restore statuses
      const unityMock = sinon.mock(getUnityInstance())
      unityMock.expects('UpdateUserPresence').once().withExactArgs({
        userId: '0xa1',
        realm: lastStatusOfFriendsEntries[0][1].realm,
        position: lastStatusOfFriendsEntries[0][1].position,
        presence: PresenceStatus.ONLINE
      })
      await expectSaga(friendsSagas.initializeStatusUpdateInterval)
        .provide([[select(getRealmConnectionString), 'realm-test']])
        .dispatch(setMatrixClient(stubClient))
        .silentRun() // due to initializeStatusUpdateInterval saga is a while(true) gen
      unityMock.verify()
    })

    it("should send status when it's stored but the new one is different", async () => {
      mockStoreCalls(undefined, lastStatusOfFriends)
      const client: SocialAPI = {
        ...stubClient,
        getUserStatuses: (...friendIds: string[]) => {
          const m = new Map()
          for (const id of friendIds) {
            const status = lastStatusOfFriends.get(id)
            if (status) {
              m.set(id, { ...status, position: { x: 100, y: 200 } }) // new status. different from the mocked ones in "entries" constant
            }
          }
          return m
        }
      }
      const unityMock = sinon.mock(getUnityInstance())
      unityMock
        .expects('UpdateUserPresence')
        .once()
        .withExactArgs({
          userId: '0xa1',
          realm: lastStatusOfFriendsEntries[0][1].realm,
          position: { x: 100, y: 200 },
          presence: PresenceStatus.ONLINE
        })
      await expectSaga(friendsSagas.initializeStatusUpdateInterval)
        .provide([
          [select(friendsSelectors.getSocialClient), client], // override the stubClient mocked by mockStoreCalls(). need this to tweak getUserStatuses client function
          [select(getRealmConnectionString), 'realm-test']
        ])
        .dispatch(setMatrixClient(client))
        .silentRun()
      unityMock.verify()
    })

    it("should not send status when it's equal to the last sent", async () => {
      mockStoreCalls(undefined, lastStatusOfFriends)
      const unityMock = sinon.mock(getUnityInstance())
      unityMock.expects('UpdateUserPresence').never()
      await expectSaga(friendsSagas.initializeStatusUpdateInterval)
        .provide([[select(getRealmConnectionString), 'some-realm']])
        .dispatch(setMatrixClient(stubClient))
        .silentRun()
      unityMock.verify()
    })
  })
})
