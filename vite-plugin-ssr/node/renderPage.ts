import { getErrorPageId, getAllPageIds, route, isErrorPage, loadPageRoutes, PageRoutes } from '../shared/route'
import { renderHtmlTemplate, isHtmlTemplate, isSanitizedString, renderSanitizedString } from './html/escapeInject'
import { AllPageFiles, getAllPageFiles_serverSide, findPageFile, findDefaultFiles } from '../shared/getPageFiles'
import { getSsrEnv } from './ssrEnv'
import { posix as pathPosix } from 'path'
import { stringify } from '@brillout/json-s'
import {
  assert,
  assertUsage,
  lowerFirst,
  isCallable,
  cast,
  assertWarning,
  hasProp,
  isPageContextUrl,
  removePageContextUrlSuffix,
  getUrlPathname,
  getUrlFull,
  isPlainObject,
  isObject,
  getUrlParsed,
  UrlParsed,
  objectAssign,
  PromiseType,
  compareString,
  assertExports,
  stringifyStringArray
} from '../shared/utils'
import { removeBaseUrl, startsWithBaseUrl } from './baseUrlHandling'
import { getPageAssets, injectAssets_internal, PageAssets } from './html/injectAssets'
import { loadPageView } from '../shared/loadPageView'
import { sortPageContext } from '../shared/sortPageContext'

export { renderPage }
export { prerenderPage }
export { renderStatic404Page }
export { getGlobalContext }
export { loadPageFiles }
export type { GlobalContext }
export { addComputedUrlProps }
export { loadOnBeforePrerenderHook }

type PageFilesData = PromiseType<ReturnType<typeof loadPageFiles>>
type GlobalContext = PromiseType<ReturnType<typeof getGlobalContext>>

async function renderPage<T extends { url: string } & Record<string, unknown>>(
  pageContext: T
): Promise<T & Record<string, unknown> & { httpResponse: null | { body: string, statusCode: 200 | 404 | 500 }}> {
  /* Not very useful because of HTTP response `{ pageContext404PageDoesNotExist: true }` with status code `200`
  : Promise<T & Record<string, unknown> & (({ httpResponse: null}) | ({httpResponse: { statusCode: 500, body: string}}) | (PageContextBuiltIn & { statusCode: 404 | 500; body: string }))>
  */
  assertArguments(...arguments)
  let { url } = pageContext
  assert(url)

  if (url.endsWith('/favicon.ico')) {
    objectAssign(pageContext, { httpResponse: null })
    return pageContext
  }

  const { urlWithoutOrigin, isPageContextRequest, hasBaseUrl } = analyzeUrl(url)
  if (!hasBaseUrl) {
    objectAssign(pageContext, { httpResponse: null })
    return pageContext
  }

  addComputedUrlProps(pageContext)

  pageContext.url = urlWithoutOrigin
  objectAssign(pageContext, {
    _isPageContextRequest: isPageContextRequest
  })

  const globalContext = await getGlobalContext()
  objectAssign(globalContext, { _isPreRendering: false as const })
  objectAssign(pageContext, globalContext)

  // *** Route ***
  // We use a try-catch because `route()` executes `.page.route.js` source code which is
  // written by the user and may contain errors.
  let pageContextRouteAddendum
  try {
    pageContextRouteAddendum = await route(pageContext)
  } catch (err) {
    objectAssign(pageContext, { _err: err })
    if (pageContext._isPageContextRequest) {
      const httpResponse = renderPageContextError(err)
      objectAssign(pageContext, { httpResponse })
    } else {
      const httpResponse = await render500Page(pageContext)
      objectAssign(pageContext, { httpResponse })
    }
    return pageContext
  }

  // *** Handle 404 ***
  let statusCode: 200 | 404
  if (pageContextRouteAddendum._pageId === null) {
    if (!pageContext._isPageContextRequest) {
      warn404(pageContext)
    }
    const errorPageId = getErrorPageId(pageContext._allPageIds)
    if (!errorPageId) {
      warnMissingErrorPage()
      if (pageContext._isPageContextRequest) {
        const httpResponse = {
          body: stringify({
            pageContext404PageDoesNotExist: true
          }),
          statusCode: 200 as const
        }
        objectAssign(pageContext, { httpResponse })
        return pageContext
      } else {
        const httpResponse = null
        objectAssign(pageContext, { httpResponse })
        return pageContext
      }
    }
    if (!pageContext._isPageContextRequest) {
      statusCode = 404
    } else {
      statusCode = 200
    }
    pageContextRouteAddendum = { _pageId: errorPageId, is404: true, routeParams: {} }
  } else {
    statusCode = 200
  }
  assert(hasProp(pageContextRouteAddendum, '_pageId', 'string'))
  assert(isPlainObject(pageContextRouteAddendum.routeParams))
  objectAssign(pageContext, pageContextRouteAddendum)

  // *** Render ***
  // We use a try-catch because `renderPageId()` execute a `*.page.*` file which is
  // written by the user and may contain an error.
  let httpResponseBody: string | null
  try {
    httpResponseBody = await renderPageId(pageContext)
  } catch (err) {
    objectAssign(pageContext, { _err: err })
    if (pageContext._isPageContextRequest) {
      const httpResponse = renderPageContextError(err)
      objectAssign(pageContext, { httpResponse })
    } else {
      const httpResponse = await render500Page(pageContext)
      objectAssign(pageContext, { httpResponse })
    }
    return pageContext
  }
  if (httpResponseBody === null) {
    objectAssign(pageContext, { httpResponse: null })
    return pageContext
  } else {
    objectAssign(pageContext, { httpResponse: { statusCode, body: httpResponseBody } })
    return pageContext
  }
}

async function renderPageId(
  pageContext: PageContextUrls & {
    url: string
    routeParams: Record<string, string>
    _pageId: string
    _isPageContextRequest: boolean
    _isPreRendering: false
    _allPageFiles: AllPageFiles
  }
): Promise<null | string> {
  const pageFilesData = await loadPageFiles(pageContext)
  objectAssign(pageContext, pageFilesData)

  await executeAddPageContextHook(pageContext)
  executeAddPageContextHook_addTypes(pageContext)

  if (pageContext._isPageContextRequest) {
    const pageContextSerialized = serializeClientPageContext(pageContext)
    return pageContextSerialized
  } else {
    const documentHtmlString = await executeRenderHook(pageContext)
    return documentHtmlString
  }
}

async function prerenderPage(
  pageContext: {
    url: string
    routeParams: Record<string, string>
    _isPreRendering: true
    _pageId: string
    _usesClientRouter: boolean
    _pageContextAlreadyProvidedByPrerenderHook?: true
    _allPageFiles: AllPageFiles
  } & PageFilesData
) {
  assert(pageContext._isPreRendering === true)

  addComputedUrlProps(pageContext)

  await executeAddPageContextHook(pageContext)
  executeAddPageContextHook_addTypes(pageContext)

  const documentHtmlString: unknown = await executeRenderHook(pageContext)
  assertUsage(
    documentHtmlString !== null,
    "Pre-rendering requires your `html()` hook to provide HTML. Open a GitHub issue if that's a problem for you."
  )
  assert(typeof documentHtmlString === 'string')
  const documentHtml: string = documentHtmlString
  if (!pageContext._usesClientRouter) {
    return { documentHtml, pageContextSerialized: null }
  } else {
    const pageContextSerialized = serializeClientPageContext(pageContext)
    return { documentHtml, pageContextSerialized }
  }
}

async function renderStatic404Page(globalContext: GlobalContext & { _isPreRendering: true }) {
  const errorPageId = getErrorPageId(globalContext._allPageIds)
  if (!errorPageId) {
    return null
  }

  const pageContext = {
    ...globalContext,
    _pageId: errorPageId,
    is404: true,
    routeParams: {},
    url: '/fake-404-url', // A `url` is needed for `applyViteHtmlTransform`
    // `renderStatic404Page()` is about generating `dist/client/404.html` for static hosts; there is no Client Routing.
    _usesClientRouter: false
  }

  const pageFilesData = await loadPageFiles(pageContext)
  objectAssign(pageContext, pageFilesData)

  return prerenderPage(pageContext)
}

function getDefaultPassToClientProps(pageContext: { _pageId: string; pageProps?: Record<string, unknown> }): string[] {
  const passToClient = []
  if (isErrorPage(pageContext._pageId)) {
    assert(hasProp(pageContext, 'is404', 'boolean'))
    const pageProps = pageContext.pageProps || {}
    pageProps['is404'] = pageProps['is404'] || pageContext.is404
    pageContext.pageProps = pageProps
    passToClient.push(...['pageProps', 'is404'])
  }
  return passToClient
}

function serializeClientPageContext(pageContext: { _pageContextClient: PageContextClient }) {
  const pageContextClient = pageContext._pageContextClient
  assert(isPlainObject(pageContextClient))
  const pageContextSerialized = stringify({
    pageContext: pageContextClient
  })
  return pageContextSerialized
}

type PageContextPublic = {
  url: string
  urlNormalized: string
  urlPathname: string
  urlParsed: UrlParsed
  routeParams: Record<string, string>
  Page: unknown
  pageExports: Record<string, unknown>
}
function preparePageContextNode<T extends PageContextPublic>(pageContext: T) {
  assert(typeof pageContext.url === 'string')
  assert(typeof pageContext.urlNormalized === 'string')
  assert(typeof pageContext.urlPathname === 'string')
  assert(isPlainObject(pageContext.urlParsed))
  assert(isPlainObject(pageContext.routeParams))
  assert('Page' in pageContext)
  assert(isObject(pageContext.pageExports))
  sortPageContext(pageContext)
}

type PageServerFileProps = {
  filePath: string
  fileExports: {
    render?: Function
    prerender?: Function
    onBeforeRender?: Function
    doNotPrerender?: true
    setPageProps: never
    passToClient?: string[]
  }
}
type PageServerFile = null | PageServerFileProps
//*
type PageServerFiles =
  | { pageServerFile: PageServerFileProps; pageServerFileDefault: PageServerFileProps }
  | { pageServerFile: null; pageServerFileDefault: PageServerFileProps }
  | { pageServerFile: PageServerFileProps; pageServerFileDefault: null }
/*/
type PageServerFiles = {
  pageServerFile: PageServerFile | null
  pageServerFileDefault: PageServerFile | null
}
//*/

function assert_pageServerFile(pageServerFile: {
  filePath: string
  fileExports: Record<string, unknown>
}): asserts pageServerFile is PageServerFileProps {
  if (pageServerFile === null) return

  const { filePath, fileExports } = pageServerFile
  assert(filePath)
  assert(fileExports)

  const render = fileExports['render']
  assertUsage(!render || isCallable(render), `The \`render()\` hook defined in ${filePath} should be a function.`)

  assertUsage(
    !('onBeforeRender' in fileExports) || isCallable(fileExports['onBeforeRender']),
    `The \`onBeforeRender()\` hook defined in ${filePath} should be a function.`
  )

  assertUsage(
    !('passToClient' in fileExports) || hasProp(fileExports, 'passToClient', 'string[]'),
    `The \`passToClient_\` export defined in ${filePath} should be an array of strings.`
  )

  const prerender = fileExports['prerender']
  assertUsage(
    !prerender || isCallable(prerender),
    `The \`prerender()\` hook defined in ${filePath} should be a function.`
  )
}

async function loadPageFiles(pageContext: { _pageId: string; _allPageFiles: AllPageFiles; _isPreRendering: boolean }) {
  const pageView = await loadPageView(pageContext)
  const pageClientPath = getPageClientPath(pageContext)

  const { pageServerFile, pageServerFileDefault } = await loadPageServerFiles(pageContext)

  const pageFilesData = {
    ...pageView,
    _pageServerFile: pageServerFile,
    _pageServerFileDefault: pageServerFileDefault,
    _pageClientPath: pageClientPath
  }

  const passToClient: string[] = [
    ...getDefaultPassToClientProps(pageContext),
    ...(pageServerFile?.fileExports.passToClient || pageServerFileDefault?.fileExports.passToClient || [])
  ]
  objectAssign(pageFilesData, {
    _passToClient: passToClient
  })

  const isPreRendering = pageContext._isPreRendering
  assert([true, false].includes(isPreRendering))
  const dependencies: string[] = [pageView._pageFilePath, pageClientPath].filter((p): p is string => p !== null)
  const pageAssets = await getPageAssets(pageContext, dependencies, pageClientPath, isPreRendering)
  objectAssign(pageFilesData, {
    _pageAssets: pageAssets
  })
  return pageFilesData
}
function getPageClientPath(pageContext: { _pageId: string; _allPageFiles: AllPageFiles }): string {
  const { _pageId: pageId, _allPageFiles: allPageFiles } = pageContext
  const pageClientFiles = allPageFiles['.page.client']
  assertUsage(
    pageClientFiles.length > 0,
    'No `*.page.client.js` file found. Make sure to create one. You can create a `_default.page.client.js` which will apply as default to all your pages.'
  )
  const pageClientPath =
    findPageFile(pageClientFiles, pageId)?.filePath || findDefaultFile(pageClientFiles, pageId)?.filePath
  assert(pageClientPath)
  return pageClientPath
}
async function loadPageServerFiles(pageContext: {
  _pageId: string
  _allPageFiles: AllPageFiles
}): Promise<PageServerFiles> {
  const pageId = pageContext._pageId
  let serverFiles = pageContext._allPageFiles['.page.server']
  assertUsage(
    serverFiles.length > 0,
    'No `*.page.server.js` file found. Make sure to create one. You can create a `_default.page.server.js` which will apply as default to all your pages.'
  )

  const serverFile = findPageFile(serverFiles, pageId)
  const serverFileDefault = findDefaultFile(serverFiles, pageId)
  assert(serverFile || serverFileDefault)
  const pageServerFile = !serverFile
    ? null
    : {
        filePath: serverFile.filePath,
        fileExports: await serverFile.loadFile()
      }
  if (pageServerFile) {
    assertExportsOfServerPage(pageServerFile.fileExports, pageServerFile.filePath)
  }
  const pageServerFileDefault = !serverFileDefault
    ? null
    : {
        filePath: serverFileDefault.filePath,
        fileExports: await serverFileDefault.loadFile()
      }
  if (pageServerFileDefault) {
    assertExportsOfServerPage(pageServerFileDefault.fileExports, pageServerFileDefault.filePath)
  }
  if (pageServerFile !== null) {
    assert_pageServerFile(pageServerFile)
  }
  if (pageServerFileDefault !== null) {
    assert_pageServerFile(pageServerFileDefault)
  }
  if (pageServerFile !== null) {
    return { pageServerFile, pageServerFileDefault }
  }
  if (pageServerFileDefault !== null) {
    return { pageServerFile, pageServerFileDefault }
  }
  assert(false)
}

type OnBeforePrerenderHook = (globalContext: { _pageRoutes: PageRoutes }) => unknown
async function loadOnBeforePrerenderHook(globalContext: {
  _allPageFiles: AllPageFiles
}): Promise<null | { onBeforePrerenderHook: OnBeforePrerenderHook; hookFilePath: string }> {
  const defautFiles = findDefaultFiles(globalContext._allPageFiles['.page.server'])
  let onBeforePrerenderHook: OnBeforePrerenderHook | null = null
  let hookFilePath: string | undefined = undefined
  await Promise.all(
    defautFiles.map(async ({ filePath, loadFile }) => {
      const fileExports = await loadFile()
      assertExportsOfServerPage(fileExports, filePath)
      if ('onBeforePrerender' in fileExports) {
        assertUsage(
          hasProp(fileExports, 'onBeforePrerender', 'function'),
          `The \`export { onBeforePrerender }\` in ${filePath} should be a function.`
        )
        assertUsage(
          onBeforePrerenderHook === null,
          'There can be only one `onBeforePrerender()` hook. If you need to be able to define several, open a new GitHub issue.'
        )
        onBeforePrerenderHook = fileExports.onBeforePrerender
        hookFilePath = filePath
      }
    })
  )
  if (!onBeforePrerenderHook) {
    return null
  }
  assert(hookFilePath)
  return { onBeforePrerenderHook, hookFilePath }
}

function assertExportsOfServerPage(fileExports: Record<string, unknown>, filePath: string) {
  assertExports(
    fileExports,
    filePath,
    ['render', 'onBeforeRender', 'passToClient', 'prerender', 'doNotPrerender', 'onBeforePrerender'],
    {
      ['_onBeforePrerender']: 'onBeforePrerender'
    },
    {
      ['addPageContext']: 'onBeforeRender'
    }
  )
}

type PageContextUser = Record<string, unknown>
type PageContextClient = { _pageId: string } & Record<string, unknown>
async function executeAddPageContextHook(
  pageContext: {
    _pageId: string
    _pageServerFile: PageServerFile
    _pageServerFileDefault: PageServerFile
    _passToClient: string[]
    _pageContextAlreadyProvidedByPrerenderHook?: true
  } & PageContextPublic
) {
  const onBeforeRender =
    pageContext._pageServerFile?.fileExports.onBeforeRender ||
    pageContext._pageServerFileDefault?.fileExports.onBeforeRender
  if (!pageContext._pageContextAlreadyProvidedByPrerenderHook && onBeforeRender) {
    const filePath = pageContext._pageServerFile?.filePath || pageContext._pageServerFileDefault?.filePath
    assert(filePath)
    preparePageContextNode(pageContext)

    const result: unknown = await onBeforeRender(pageContext)
    assertHookResult(result, 'onBeforeRender', ['pageContext'] as const, filePath)
    Object.assign(pageContext, result?.pageContext)
  }

  const pageContextClient: PageContextClient = { _pageId: pageContext._pageId }
  pageContext._passToClient.forEach((prop) => {
    pageContextClient[prop] = (pageContext as PageContextUser)[prop]
  })
  ;(pageContext as Record<string, unknown>)['_pageContextClient'] = pageContextClient
}
function executeAddPageContextHook_addTypes<PageContext extends Record<string, unknown>>(
  pageContext: PageContext
): asserts pageContext is PageContext & { _pageContextClient: PageContextClient } {
  pageContext // make TS happy
}

async function executeRenderHook(
  pageContext: PageContextPublic & {
    _pageId: string
    _pageContextClient: Record<string, unknown>
    _pageAssets: PageAssets
    _pageServerFile: PageServerFile
    _pageServerFileDefault: PageServerFile
    _pageFilePath: string | null
    _pageClientPath: string
    _passToClient: string[]
  }
): Promise<string | null> {
  assert(pageContext._pageServerFile || pageContext._pageServerFileDefault)
  let render
  let renderFilePath
  const pageServerFile = pageContext._pageServerFile
  const pageRenderFunction = pageServerFile?.fileExports.render
  if (pageServerFile && pageRenderFunction) {
    render = pageRenderFunction
    renderFilePath = pageServerFile.filePath
  } else {
    const pageServerFileDefault = pageContext._pageServerFileDefault
    const pageDefaultRenderFunction = pageServerFileDefault?.fileExports.render
    if (pageServerFileDefault && pageDefaultRenderFunction) {
      render = pageDefaultRenderFunction
      renderFilePath = pageServerFileDefault.filePath
    }
  }
  assertUsage(
    render,
    'No `render()` hook found. Make sure to define a `*.page.server.js` file with `export function render() { /*...*/ }`. You can also `export { render }` in `_default.page.server.js` which will be the default `render()` hook of all your pages.'
  )
  assert(renderFilePath)

  preparePageContextNode(pageContext)
  const result: unknown = await render(pageContext)
  if (isObject(result) && !isSanitizedString(result) && !isHtmlTemplate(result)) {
    assertHookResult(result, 'render', ['documentHtml', 'pageContext'] as const, renderFilePath)
  }

  if (hasProp(result, 'pageContext')) {
    Object.assign(pageContext, result.pageContext)
  }

  let documentHtml: unknown
  let definedOverObject: boolean
  if (hasProp(result, 'documentHtml')) {
    documentHtml = result.documentHtml
    definedOverObject = true
  } else {
    documentHtml = result
    definedOverObject = false
  }
  const errPrefix = `The \`render()\` hook exported by ${renderFilePath}`
  const errSuffix = 'You can use the `escapeInject` template tag, or wrap your HTML string with `dangerouslySkipEscape(htmlString)`, see https://vite-plugin-ssr/escapeInject'
  // (you can mark a string as "HTML-sanitized" by using \`escapeInject\` or \`dangerouslySkipEscape()\`).`
  assertUsage(
    typeof documentHtml !== 'string',
    `${errPrefix} returned ${!definedOverObject?'':'{ documentHtml }` but `documentHtml` is '}a plain JavaScript string which is forbidden; your string should be HTML-sanitized. ${errSuffix}`
  )
  assertUsage(
    documentHtml === null || isSanitizedString(documentHtml) || isHtmlTemplate(documentHtml),
    `${errPrefix} ${!definedOverObject?'should return':'returned `{ documentHtml }` but `documentHtml` should be'} \`null\` or an HTML-sanitized string. ${errSuffix}`
  )

  if (documentHtml === null) {
    return null
  }

  let documentHtmlString: string
  if (isSanitizedString(documentHtml)) {
    documentHtmlString = renderSanitizedString(documentHtml)
  } else if (isHtmlTemplate(documentHtml)) {
    documentHtmlString = renderHtmlTemplate(documentHtml, renderFilePath)
  } else {
    assert(false)
  }

  documentHtmlString = await injectAssets_internal(documentHtmlString, pageContext)

  return documentHtmlString
}

function assertHookResult<Keys extends readonly string[]>(
  hookResult: unknown,
  hookName: string,
  hookResultKeys: Keys,
  hookFile: string
): asserts hookResult is undefined | null | { [key in Keys[number]]?: unknown } {
  const errPrefix = `The \`${hookName}()\` hook exported by ${hookFile}`
  assertUsage(
    hookResult === null || hookResult === undefined || isPlainObject(hookResult),
    `${errPrefix} should return \`null\`, \`undefined\`, or a plain JavaScript object.`
  )
  if (hookResult === undefined || hookResult === null) {
    return
  }
  const unknownKeys = []
  for (const key of Object.keys(hookResult)) {
    if (!hookResultKeys.includes(key)) {
      unknownKeys.push(key)
    }
  }
  assertUsage(
    unknownKeys.length === 0,
    `${errPrefix} returned an object with unknown keys ${stringifyStringArray(
      unknownKeys
    )}. Only following keys are allowed: ${stringifyStringArray(hookResultKeys)}.`
  )
}

function findDefaultFile<T extends { filePath: string }>(pageFiles: T[], pageId: string): T | null {
  const defautFiles = findDefaultFiles(pageFiles)

  // Sort `_default.page.server.js` files by filesystem proximity to pageId's `*.page.js` file
  defautFiles.sort(
    lowerFirst(({ filePath }) => {
      if (filePath.startsWith(pageId)) return -1
      assert(!filePath.includes('\\'))
      assert(!pageId.includes('\\'))
      const relativePath = pathPosix.relative(pageId, filePath)
      assert(!relativePath.includes('\\'))
      const changeDirCount = relativePath.split('/').length
      return changeDirCount
    })
  )

  return defautFiles[0] || null
}

function assertArguments(...args: unknown[]) {
  const pageContext = args[0]
  assertUsage(pageContext, '`renderPage(pageContext)`: argument `pageContext` is missing.')
  assertUsage(
    isPlainObject(pageContext),
    `\`renderPage(pageContext)\`: argument \`pageContext\` should be a plain JavaScript object, but you passed a \`pageContext\` with \`pageContext.constructor === ${
      (pageContext as any).constructor
    }\`.`
  )
  assertUsage(
    hasProp(pageContext, 'url'),
    '`renderPage(pageContext)`: The `pageContext` you passed is missing the property `pageContext.url`.'
  )
  assertUsage(
    typeof pageContext.url === 'string',
    '`renderPage(pageContext)`: `pageContext.url` should be a string but we got `typeof pageContext.url === "' +
      typeof pageContext.url +
      '"`.'
  )
  try {
    removeOrigin(pageContext.url)
  } catch (err) {
    assertUsage(
      false,
      '`renderPage(pageContext)`: argument `pageContext.url` should be a URL but we got `url==="' +
        pageContext.url +
        '"`.'
    )
  }
  const len = args.length
  assertUsage(
    len === 1,
    `\`renderPage(pageContext)\`: You passed ${len} arguments but \`renderPage()\` accepts only one argument.'`
  )
}

function warnMissingErrorPage() {
  const { isProduction } = getSsrEnv()
  if (!isProduction) {
    assertWarning(
      false,
      'No `_error.page.js` found. We recommend creating a `_error.page.js` file. (This warning is not shown in production.)'
    )
  }
}
function warn404(pageContext: { urlPathname: string; _pageRoutes: PageRoutes }) {
  const { isProduction } = getSsrEnv()
  const pageRoutes = pageContext._pageRoutes
  assertUsage(
    pageRoutes.length > 0,
    'No page found. Create a file that ends with the suffix `.page.js` (or `.page.vue`, `.page.jsx`, ...).'
  )
  const { urlPathname } = pageContext
  if (!isProduction && !isFileRequest(urlPathname)) {
    assertWarning(
      false,
      [
        `URL \`${urlPathname}\` is not matching any of your ${pageRoutes.length} page routes (this warning is not shown in production):`,
        ...getPagesAndRoutesInfo(pageRoutes)
      ].join('\n')
    )
  }
}
function getPagesAndRoutesInfo(pageRoutes: PageRoutes) {
  return pageRoutes
    .map((pageRoute) => {
      const { pageId, filesystemRoute, pageRouteFile } = pageRoute
      let route
      let routeType
      if (pageRouteFile) {
        const { routeValue } = pageRouteFile
        route =
          typeof routeValue === 'string'
            ? routeValue
            : truncateString(String(routeValue).split(/\s/).filter(Boolean).join(' '), 64)
        routeType = typeof routeValue === 'string' ? 'Route String' : 'Route Function'
      } else {
        route = filesystemRoute
        routeType = 'Filesystem Route'
      }
      return `\`${route}\` (${routeType} of \`${pageId}.page.*\`)`
    })
    .sort(compareString)
    .map((line, i) => {
      const nth = (i + 1).toString().padStart(pageRoutes.length.toString().length, '0')
      return ` (${nth}) ${line}`
    })
}

function truncateString(str: string, len: number) {
  if (len > str.length) {
    return str
  } else {
    str = str.substring(0, len)
    return str + '...'
  }
}

function isFileRequest(urlPathname: string) {
  assert(urlPathname.startsWith('/'))
  const paths = urlPathname.split('/')
  const lastPath = paths[paths.length - 1]
  assert(typeof lastPath === 'string')
  const parts = lastPath.split('.')
  if (parts.length < 2) {
    return false
  }
  const fileExtension = parts[parts.length - 1]
  assert(typeof fileExtension === 'string')
  return /^[a-z0-9]+$/.test(fileExtension)
}

async function render500Page(
  pageContext: PageContextUrls & {
    url: string
    _allPageIds: string[]
    _allPageFiles: AllPageFiles
    _isPreRendering: false
    _err: unknown
  }
) {
  handleError(pageContext._err)

  const errorPageId = getErrorPageId(pageContext._allPageIds)
  if (errorPageId === null) {
    warnMissingErrorPage()
    const httpResponse = null
    return httpResponse
  }

  objectAssign(pageContext, {
    is404: false,
    _pageId: errorPageId,
    _isPageContextRequest: false,
    routeParams: {} as Record<string, string>
  })

  let httpResponseBody: string | null
  try {
    httpResponseBody = await renderPageId(pageContext)
  } catch (err) {
    // We purposely swallow the error, because another error was already shown to the user in `handleError()`.
    // (And chances are high that this is the same error.)
    const httpResponse = null
    return httpResponse
  }
  if (httpResponseBody === null) {
    const httpResponse = null
    return httpResponse
  }
  const httpResponse = {
    body: httpResponseBody,
    statusCode: 500 as const
  }
  return httpResponse
}

function renderPageContextError(err?: unknown) {
  if (err) {
    handleError(err)
  }
  const httpResponse = {
    body: stringify({
      userError: true
    }),
    statusCode: 500 as const
  }
  return httpResponse
}

function handleError(err: unknown) {
  const { viteDevServer } = getSsrEnv()
  if (viteDevServer) {
    cast<Error>(err)
    if (err?.stack) {
      viteDevServer.ssrFixStacktrace(err)
    }
  }
  // We ensure we print a string; Cloudflare Workers doesn't seem to properly stringify `Error` objects.
  const errStr = (hasProp(err, 'stack') && String(err.stack)) || String(err)
  console.error(errStr)
}

function removeOrigin(url: string): string {
  const urlFull = getUrlFull(url)
  return urlFull
}

type PageContextUrls = { urlNormalized: string; urlPathname: string; urlParsed: UrlParsed }

function analyzeUrl(url: string): {
  urlWithoutOrigin: string
  urlNormalized: string
  isPageContextRequest: boolean
  hasBaseUrl: boolean
} {
  const isPageContextRequest = isPageContextUrl(url)
  if (isPageContextRequest) {
    url = removePageContextUrlSuffix(url)
  }
  const urlWithoutOrigin = url

  url = removeOrigin(url)
  assert(url.startsWith('/'))

  const hasBaseUrl = startsWithBaseUrl(url)
  if (hasBaseUrl) {
    url = removeBaseUrl(url)
  }

  const urlNormalized = url
  return { urlWithoutOrigin, urlNormalized, isPageContextRequest, hasBaseUrl }
}

function addComputedUrlProps<PageContext extends Record<string, unknown> & { url: string }>(
  pageContext: PageContext
): asserts pageContext is PageContext & PageContextUrls {
  if ('urlNormalized' in pageContext) {
    assert(Object.getOwnPropertyDescriptor(pageContext, 'urlNormalized')?.get === urlNormalizedGetter)
    assert(Object.getOwnPropertyDescriptor(pageContext, 'urlPathname')?.get === urlPathnameGetter)
    assert(Object.getOwnPropertyDescriptor(pageContext, 'urlParsed')?.get === urlParsedGetter)
  } else {
    Object.defineProperty(pageContext, 'urlNormalized', { get: urlNormalizedGetter })
    Object.defineProperty(pageContext, 'urlPathname', { get: urlPathnameGetter })
    Object.defineProperty(pageContext, 'urlParsed', { get: urlParsedGetter })
  }
}
function urlNormalizedGetter(this: { url: string }) {
  assert(hasProp(this, 'url', 'string'))
  return analyzeUrl(this.url).urlNormalized
}
function urlPathnameGetter(this: { urlNormalized: string }) {
  return getUrlPathname(this.urlNormalized)
}
function urlParsedGetter(this: { urlNormalized: string }) {
  return getUrlParsed(this.urlNormalized)
}

async function getGlobalContext() {
  const globalContext = {}

  const allPageFiles = await getAllPageFiles_serverSide()
  objectAssign(globalContext, {
    _allPageFiles: allPageFiles
  })

  const allPageIds = await getAllPageIds(allPageFiles)
  objectAssign(globalContext, { _allPageIds: allPageIds })

  const { pageRoutes, onBeforeRouteHook } = await loadPageRoutes(globalContext)
  objectAssign(globalContext, { _pageRoutes: pageRoutes, _onBeforeRouteHook: onBeforeRouteHook })

  return globalContext
}