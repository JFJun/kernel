// This file decides and loads the renderer of choice

import { initializeRenderer } from 'shared/renderer/actions'
import { ensureUnityInterface } from 'shared/renderer'
import { CommonRendererOptions, loadUnity } from './loader'
import type { UnityGame } from '@dcl/unity-renderer/src/index'
import type { KernelOptions } from '@dcl/kernel-interface'

import { initializeUnityEditor } from './wsEditorAdapter'
import { traceDecoratorRendererOptions } from './trace'
import {
  BringDownClientAndShowError,
  ErrorContext,
  ReportFatalErrorWithUnityPayload
} from 'shared/loading/ReportFatalError'
import { UNEXPECTED_ERROR } from 'shared/loading/types'
import { store } from 'shared/store/isolatedStore'
import defaultLogger from 'shared/logger'
import { browserInterface } from './BrowserInterface'
import { webTransport } from '../renderer-protocol/transports/webTransport'
import { createRendererRpcClient } from '../renderer-protocol/rpcClient'

export type InitializeUnityResult = {
  container: HTMLElement
}

const rendererOptions: Partial<KernelOptions['rendererOptions']> = {}

const defaultOptions: CommonRendererOptions = traceDecoratorRendererOptions({
  onMessage(type: string, jsonEncodedMessage: string) {
    let parsedJson = null
    try {
      parsedJson = JSON.parse(jsonEncodedMessage)
    } catch (e: any) {
      // we log the whole message to gain visibility
      defaultLogger.error(e.message + ' messageFromEngine: ' + type + ' ' + jsonEncodedMessage)
      throw e
    }
    // this is outside of the try-catch to enable V8 path optimizations
    // keep the following line outside the `try`
    browserInterface.handleUnityMessage(type, parsedJson)
  }
})

async function loadInjectedUnityDelegate(container: HTMLElement): Promise<UnityGame> {
  // inject unity loader
  const rootArtifactsUrl = rendererOptions.baseUrl || ''

  const { createWebRenderer } = await loadUnity(rootArtifactsUrl, defaultOptions)

  preventUnityKeyboardLock()

  const canvas = document.createElement('canvas')
  canvas.id = '#canvas'
  container.appendChild(canvas)

  const { originalUnity, engineStartedFuture } = await createWebRenderer(canvas)

  const ctx: WebGL2RenderingContext = (originalUnity.Module as any).ctx

  const debug_ext = ctx.getExtension('WEBGL_debug_renderer_info')
  if (debug_ext) {
    const renderer = ctx.getParameter(debug_ext.UNMASKED_RENDERER_WEBGL)
    if (renderer.indexOf('SwiftShader') >= 0) {
      throw new Error(
        'Your browser is using an emulated software renderer (SwiftShader). This prevents Decentraland from working. This is usually fixed by restarting the computer. In any case, we recommend you to use the Desktop Client instead for a better overall experience. You can find it in https://decentraland.org/download'
      )
    }
  }

  canvas.addEventListener(
    'webglcontextlost',
    function (event) {
      event.preventDefault()
      BringDownClientAndShowError(
        'The rendering engine failed. This is an unrecoverable error that is subject to the available memory and resources of your browser.\n' +
          'For a better experience, we recommend using the Native Desktop Client. You can find it in https://decentraland.org/download'
      )
    },
    false
  )

  // TODO: move to unity-renderer js project
  originalUnity.Module.errorHandler = (message: string, filename: string, lineno: number) => {
    console['error'](message, filename, lineno)

    if (message.includes('The error you provided does not contain a stack trace')) {
      // This error is something that react causes only on development, with unhandled promises and strange errors with no stack trace (i.e, matrix errors).
      // Some libraries (i.e, matrix client) don't handle promises well and we shouldn't crash the explorer because of that
      return true
    }

    const error = new Error(`${message} ... file: ${filename} - lineno: ${lineno}`)
    ReportFatalErrorWithUnityPayload(error, ErrorContext.RENDERER_ERRORHANDLER)
    BringDownClientAndShowError(UNEXPECTED_ERROR)
    return true
  }

  const transport = webTransport({ wasmModule: originalUnity.Module })
  createRendererRpcClient(transport).catch((e) => {
    console.error(e)
    debugger
  })

  await engineStartedFuture
  await browserInterface.startedFuture

  return originalUnity
}

/** Initialize engine using WS transport (UnityEditor) */
async function loadWsEditorDelegate(container: HTMLElement): Promise<UnityGame> {
  const queryParams = new URLSearchParams(document.location.search)

  return initializeUnityEditor(queryParams.get('ws')!, container, defaultOptions)
}

/** Initialize the injected engine in a container */
export async function initializeUnity(options: KernelOptions['rendererOptions']): Promise<InitializeUnityResult> {
  const queryParams = new URLSearchParams(document.location.search)

  Object.assign(rendererOptions, options)
  const { container } = rendererOptions

  if (queryParams.has('ws')) {
    // load unity renderer using WebSocket
    store.dispatch(initializeRenderer(loadWsEditorDelegate, container))
  } else {
    // load injected renderer
    store.dispatch(initializeRenderer(loadInjectedUnityDelegate, container))
  }

  // wait until the renderer is fully loaded before returning, this
  // is important because once this function returns, it is assumed
  // that the renderer will be ready
  await ensureUnityInterface()

  return {
    container
  }
}

/**
 * Prevent unity from locking the keyboard when there is an
 * active element (like delighted textarea)
 */
function preventUnityKeyboardLock() {
  const originalFunction = window.addEventListener
  window.addEventListener = function (event: any, handler: any, options?: any) {
    if (['keypress', 'keydown', 'keyup'].includes(event)) {
      originalFunction.call(
        window,
        event,
        (e) => {
          if (!document.activeElement || document.activeElement === document.body) {
            handler(e)
          }
        },
        options
      )
    } else {
      originalFunction.call(window, event, handler, options)
    }
    return true
  }
}
