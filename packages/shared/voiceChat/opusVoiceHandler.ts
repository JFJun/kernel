import { createLogger } from 'shared/logger'
import { VoiceHandler } from './VoiceHandler'
import { VoiceCommunicator } from './VoiceCommunicator'
import { commConfigurations } from 'config'
import Html from 'shared/Html'
import { getCommsRoom } from 'shared/comms/selectors'
import { getSpatialParamsFor } from './utils'
import * as rfc4 from '@dcl/protocol/out-ts/decentraland/kernel/comms/rfc4/comms.gen'
import { store } from 'shared/store/isolatedStore'
import withCache from 'atomicHelpers/withCache'

const getVoiceCommunicator = withCache(() => {
  const logger = createLogger('OpusVoiceCommunicator: ')
  return new VoiceCommunicator(
    {
      send(frame: rfc4.Voice) {
        const transport = getCommsRoom(store.getState())
        transport?.sendVoiceMessage(frame).catch(logger.error)
      }
    },
    {
      initialListenerParams: undefined,
      panningModel: commConfigurations.voiceChatUseHRTF ? 'HRTF' : 'equalpower',
      loopbackAudioElement: Html.loopbackAudioElement()
    }
  )
})

export const createOpusVoiceHandler = (): VoiceHandler => {
  const voiceCommunicator = getVoiceCommunicator()

  return {
    setRecording(recording) {
      if (recording) {
        voiceCommunicator.start()
      } else {
        voiceCommunicator.pause()
      }
    },
    onUserTalking(cb) {
      voiceCommunicator.addStreamPlayingListener((streamId: string, playing: boolean) => {
        cb(streamId, playing)
      })
    },
    onRecording(cb) {
      voiceCommunicator.addStreamRecordingListener((recording: boolean) => {
        cb(recording)
      })
    },
    onError(cb) {
      voiceCommunicator.addStreamRecordingErrorListener((message) => {
        cb(message)
      })
    },
    reportPosition(position: rfc4.Position) {
      voiceCommunicator.setListenerSpatialParams(getSpatialParamsFor(position))
    },
    setVolume: function (volume) {
      voiceCommunicator.setVolume(volume)
    },
    setMute: (mute) => {
      voiceCommunicator.setMute(mute)
    },
    setInputStream: (stream) => {
      return voiceCommunicator.setInputStream(stream)
    },
    hasInput: () => {
      return voiceCommunicator.hasInput()
    },
    playEncodedAudio: (src, position, encoded) => {
      return voiceCommunicator.playEncodedAudio(src, getSpatialParamsFor(position), encoded)
    },
    destroy() {
      // noop
    }
  }
}
