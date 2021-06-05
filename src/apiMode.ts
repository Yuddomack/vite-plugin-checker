import os from 'os'
import ts from 'typescript'
import { ErrorPayload } from 'vite'

import { PluginOptions } from './types'
import { ensureCall, formatHost, tsDiagnosticToViteError } from './utils'

import type { UserConfig, ViteDevServer } from 'vite'

/**
 * Prints a diagnostic every time the watch status changes.
 * This is mainly for messages like "Starting compilation" or "Compilation completed".
 */
export function createDiagnostic(userOptions: Partial<PluginOptions> = {}) {
  let overlay = true // Vite defaults to true
  let currErr: ErrorPayload['err'] | null = null

  return {
    config: (config: UserConfig) => {
      const hmr = config.server?.hmr
      const viteOverlay = !(typeof hmr === 'object' && hmr.overlay === false)

      if (userOptions.overlay === false || !viteOverlay) {
        overlay = false
      }
    },
    configureServer(server: ViteDevServer) {
      const finalConfig = {
        root: userOptions.root ?? server.config.root,
        tsconfigPath: userOptions.tsconfigPath ?? 'tsconfig.json',
      }

      let configFile: string | undefined

      configFile = ts.findConfigFile(finalConfig.root, ts.sys.fileExists, finalConfig.tsconfigPath)

      if (configFile === undefined) {
        throw Error(
          `Failed to find a valid tsconfig.json: ${finalConfig.tsconfigPath} at ${finalConfig.root} is not a valid tsconfig`
        )
      }

      // https://github.com/microsoft/TypeScript/blob/a545ab1ac2cb24ff3b1aaf0bfbfb62c499742ac2/src/compiler/watch.ts#L12-L28
      const reportDiagnostic = (diagnostic: ts.Diagnostic) => {
        const originalDiagnostic = ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost)

        if (!currErr) {
          currErr = tsDiagnosticToViteError(diagnostic)
        }

        ensureCall(() => {
          ts.sys.write(originalDiagnostic)
        })
      }

      const reportWatchStatusChanged: ts.WatchStatusReporter = (
        diagnostic,
        newLine,
        options,
        errorCount
        // eslint-disable-next-line max-params
      ) => {
        // https://github.com/microsoft/TypeScript/issues/32542
        switch (diagnostic.code) {
          case 6032: // Incremental build
            // clear current error and use the newer errors
            currErr = null
            break
          case 6031: // Initial build
          case 6193: // 1 Error
          case 6194: // 0 errors or 2+ errors
            if (currErr && overlay) {
              server.ws.send({
                type: 'error',
                err: currErr,
              })
            }

            ensureCall(() => {
              ts.sys.write(os.EOL + os.EOL + diagnostic.messageText.toString())
            })
        }
      }

      // https://github.com/microsoft/TypeScript/issues/32385
      // https://github.com/microsoft/TypeScript/pull/33082/files
      const createProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram
      const host = ts.createWatchCompilerHost(
        configFile,
        { noEmit: true },
        ts.sys,
        createProgram,
        reportDiagnostic,
        reportWatchStatusChanged
      )

      // You can technically override any given hook on the host, though you probably
      // don't need to.
      // Note that we're assuming `origCreateProgram` and `origPostProgramCreate`
      // doesn't use `this` at all.
      // const origCreateProgram = host.createProgram
      // @ts-ignore
      // host.createProgram = (rootNames: ReadonlyArray<string>, options, host, oldProgram) => {
      //   console.log("** We're about to create the program! **")
      //   return origCreateProgram(rootNames, options, host, oldProgram)
      // }

      // const origPostProgramCreate = host.afterProgramCreate

      // host.afterProgramCreate = (program) => {
      //   console.log('** We finished making the program! **')
      //   origPostProgramCreate!(program)
      // }

      // `createWatchProgram` creates an initial program, watches files, and updates
      // the program over time.
      ts.createWatchProgram(host)
    },
  }
}

export const diagnostic = createDiagnostic()