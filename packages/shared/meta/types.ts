import { RenderProfile } from 'shared/types'
import { FeatureFlagVariant } from '@dcl/feature-flags'

export type MetaConfiguration = {
  explorer: {
    minBuildNumber: number
    assetBundlesFetchUrl: string
  }
  servers: {
    added: string[]
    denied: string[]
    contentWhitelist: string[]
    catalystsNodesEndpoint?: string
  }
  synapseUrl: string
  world: WorldConfig
  comms: CommsConfig
  minCatalystVersion?: string
  featureFlagsV2?: FeatureFlag
}

export type FeatureFlagsName =
  | 'quests' // quests feature
  | 'retry_matrix_login' // retry matrix reconnection
  | 'parcel-denylist' // denylist of specific parcels using variants
  | 'matrix_disabled' // disable matrix integration entirely
  | 'matrix_presence_disabled' // disable matrix presence feature
  | 'matrix_channels_enabled' // enables matrix channels feature
  | 'max_joined_channels' // the max amount of joined channels allowed per user
  | 'users_allowed_to_create_channels' // users who are allowed to create channels
  | 'builder_in_world'
  | 'avatar_lods'
  | 'asset_bundles'
  | 'explorev2'
  | 'unsafe-request'
  | 'pick_realm_algorithm_config'
  | 'banned_users'
  | 'max_visible_peers'
  | 'initial_portable_experiences'
  | 'web_cap_fps' // caps the web client FPS
  | 'disabled-catalyst'
  | 'livekit-voicechat'
  | 'ping_enabled'

export type BannedUsers = Record<string, Ban[]>

export type Ban = {
  type: 'VOICE_CHAT_AND_CHAT' // For now we only handle one ban type
  expiration: number // Timestamp
}

export type WorldConfig = {
  renderProfile?: RenderProfile
  enableNewTutorialCamera?: boolean
}

export type MetaState = {
  initialized: boolean
  config: Partial<MetaConfiguration>
}

export type RootMetaState = {
  meta: MetaState
}

export type CommsConfig = {
  targetConnections?: number
  maxConnections?: number
  relaySuspensionDisabled?: boolean
  relaySuspensionInterval?: number
  relaySuspensionDuration?: number
}

export type FeatureFlag = {
  flags: Partial<Record<FeatureFlagsName, boolean>>
  variants: Partial<Record<FeatureFlagsName, FeatureFlagVariant>>
}
