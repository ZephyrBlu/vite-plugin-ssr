export { getExportUnion }
export { getExports }
export type { ExportsAll }
export type { PageContextExports }

import { assert, hasProp, isObject, assertWarning, assertUsage, makeLast, isBrowser, isJavaScriptFile } from '../utils'
import { assertDefaultExports, forbiddenDefaultExports } from './assertExports'
import type { FileType, PageFile } from './types'

type ExportsAll = Record<
  string,
  { exportValue: unknown; _filePath: string; _fileType: FileType; _isFromDefaultExport: boolean }[]
>
type PageContextExports = {
  exportsAll: ExportsAll
  pageExports: Record<string, unknown>
  exports: Record<string, unknown>
}

function getExports(pageFiles: PageFile[]): PageContextExports {
  const exportsAll: ExportsAll = {}

  pageFiles.forEach((pageFile) => {
    const exportValues = getExportValues(pageFile)
    exportValues.forEach(({ exportName, exportValue, isFromDefaultExport }) => {
      assert(exportName !== 'default')
      exportsAll[exportName] = exportsAll[exportName] ?? []
      exportsAll[exportName]!.push({
        exportValue,
        _filePath: pageFile.filePath,
        _fileType: pageFile.fileType,
        _isFromDefaultExport: isFromDefaultExport
      })
    })
  })

  const pageExports = createObjectWithDeprecationWarning()
  const exports: Record<string, unknown> = {}
  Object.entries(exportsAll).forEach(([exportName, values]) => {
    values.forEach(({ exportValue, _fileType, _isFromDefaultExport }) => {
      exports[exportName] = exports[exportName] ?? exportValue

      // Legacy `pageContext.pageExports`
      if (_fileType === '.page' && !_isFromDefaultExport) {
        if (!(exportName in pageExports)) {
          pageExports[exportName] = exportValue
        }
      }
    })
  })

  assert(!('default' in exports))
  assert(!('default' in exportsAll))

  return {
    exports,
    exportsAll,
    pageExports
  }
}

function getExportValues(pageFile: PageFile) {
  const { filePath, fileExports } = pageFile
  assert(fileExports) // assume pageFile.loadFile() was called

  const exportValues: {
    exportName: string
    exportValue: unknown
    isFromDefaultExport: boolean
  }[] = []

  Object.entries(fileExports)
    .sort(makeLast(([exportName]) => exportName === 'default')) // `export { bla }` should override `export default { bla }`
    .forEach(([exportName, exportValue]) => {
      let isFromDefaultExport = exportName === 'default'

      if (isFromDefaultExport) {
        if (!isJavaScriptFile(filePath)) {
          // `.vue` and `.md` files
          exportName = 'Page'
        } else {
          assertUsage(isObject(exportValue), `The \`export default\` of ${filePath} should be an object.`)
          Object.entries(exportValue).forEach(([defaultExportName, defaultExportValue]) => {
            assertDefaultExports(defaultExportName, filePath)
            exportValues.push({
              exportName: defaultExportName,
              exportValue: defaultExportValue,
              isFromDefaultExport
            })
          })
          return
        }
      }

      exportValues.push({
        exportName,
        exportValue,
        isFromDefaultExport
      })
    })

  exportValues.forEach(({ exportName, isFromDefaultExport }) => {
    assert(!(isFromDefaultExport && forbiddenDefaultExports.includes(exportName)))
  })

  return exportValues
}

function createObjectWithDeprecationWarning(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(...args) {
        // We only show the warning in Node.js because when using Client Routing Vue integration uses `Object.assign(pageContextReactive, pageContext)` which will wrongully trigger the warning. There is no cross-browser way to catch whether the property accessor was initiated by an `Object.assign()` call.
        if (!isBrowser()) {
          assertWarning(
            false,
            '`pageContext.pageExports` is outdated. Use `pageContext.exports` instead, see https://vite-plugin-ssr.com/exports',
            { onlyOnce: true, showStackTrace: true }
          )
        }
        return Reflect.get(...args)
      }
    }
  )
}

function getExportUnion(exportsAll: ExportsAll, propName: string): string[] {
  return (
    exportsAll[propName]
      ?.map((e) => {
        assertUsage(
          hasProp(e, 'exportValue', 'string[]'),
          `\`export { ${propName} }\` of ${e._filePath} should be an array of strings.`
        )
        return e.exportValue
      })
      .flat() ?? []
  )
}
