import { navigationState } from '../navigationState'
import {
  assert,
  assertUsage,
  getFileUrl,
  hasProp,
  isPlainObject,
  objectAssign,
  getProjectError,
  serverSideRouteTo,
} from './utils'
import { parse } from '@brillout/json-s/parse'
import { getPageContextSerializedInHtml } from '../getPageContextSerializedInHtml'
import { PageContextExports, PageFile } from '../../shared/getPageFiles'
import { analyzePageServerSide } from '../../shared/getPageFiles/analyzePageServerSide'
import type { PageContextUrls } from '../../shared/addComputedUrlProps'
import { assertHookResult } from '../../shared/assertHookResult'
import { getErrorPageId, PageContextForRoute, route } from '../../shared/route'
import { getHook } from '../../shared/getHook'
import { releasePageContext } from '../releasePageContext'
import { loadPageFilesClientSide } from '../loadPageFilesClientSide'
import { removeBuiltInOverrides } from './getPageContext/removeBuiltInOverrides'

export { getPageContext }
export { getPageContextErrorPage }

type PageContextAddendum = {
  _pageId: string
  _pageContextRetrievedFromServer: null | Record<string, unknown>
  isHydration: boolean
  _comesDirectlyFromServer: boolean
  _pageFilesLoaded: PageFile[]
} & PageContextExports

async function getPageContext(
  pageContext: {
    _isFirstRenderAttempt: boolean
  } & PageContextUrls &
    PageContextForRoute,
): Promise<PageContextAddendum> {
  if (pageContext._isFirstRenderAttempt && navigationState.isOriginalUrl(pageContext.url)) {
    assert(hasProp(pageContext, '_isFirstRenderAttempt', 'true'))
    return getPageContextFirstRender(pageContext)
  } else {
    assert(hasProp(pageContext, '_isFirstRenderAttempt', 'false'))
    return getPageContextUponNavigation(pageContext)
  }
}

async function getPageContextFirstRender(pageContext: {
  _pageFilesAll: PageFile[]
  _isFirstRenderAttempt: true
  url: string
}): Promise<PageContextAddendum> {
  const pageContextAddendum = getPageContextSerializedInHtml()
  removeBuiltInOverrides(pageContextAddendum)

  objectAssign(pageContextAddendum, {
    isHydration: true,
    _comesDirectlyFromServer: true,
  })

  objectAssign(
    pageContextAddendum,
    await loadPageFilesClientSide(pageContext._pageFilesAll, pageContextAddendum._pageId),
  )

  return pageContextAddendum
}

async function getPageContextErrorPage(pageContext: {
  url: string
  _allPageIds: string[]
  _isFirstRenderAttempt: boolean
  _pageFilesAll: PageFile[]
}): Promise<PageContextAddendum> {
  const errorPageId = getErrorPageId(pageContext._allPageIds)
  if (!errorPageId) {
    throw new Error('No error page')
  }
  const pageContextAddendum = {
    isHydration: false,
    _pageId: errorPageId,
    _pageContextRetrievedFromServer: null,
    _comesDirectlyFromServer: false,
  }

  objectAssign(
    pageContextAddendum,
    await loadPageFilesClientSide(pageContext._pageFilesAll, pageContextAddendum._pageId),
  )

  return pageContextAddendum
}

async function getPageContextUponNavigation(
  pageContext: PageContextForRoute & { _isFirstRenderAttempt: false },
): Promise<PageContextAddendum> {
  const pageContextAddendum = {
    isHydration: false,
  }
  objectAssign(pageContextAddendum, await getPageContextFromRoute(pageContext))

  objectAssign(
    pageContextAddendum,
    await loadPageFilesClientSide(pageContext._pageFilesAll, pageContextAddendum._pageId),
  )

  objectAssign(pageContextAddendum, await onBeforeRenderExecute({ ...pageContext, ...pageContextAddendum }))
  assert([true, false].includes(pageContextAddendum._comesDirectlyFromServer))

  if (pageContextAddendum['_isError'] === true) {
    assert(hasProp(pageContextAddendum, 'is404', 'boolean'))
    assert(hasProp(pageContextAddendum, 'pageProps', 'object'))
    assert(hasProp(pageContextAddendum.pageProps, 'is404', 'boolean'))
    objectAssign(pageContextAddendum, {
      _pageId: getErrorPageId(pageContext._allPageIds),
    })
    objectAssign(
      pageContextAddendum,
      await loadPageFilesClientSide(pageContext._pageFilesAll, pageContextAddendum._pageId),
    )
  }

  return pageContextAddendum
}

async function onBeforeRenderExecute(
  pageContext: {
    _pageId: string
    url: string
    isHydration: boolean
    _pageFilesAll: PageFile[]
  } & PageContextExports,
): Promise<
  { _comesDirectlyFromServer: boolean; _pageContextRetrievedFromServer: null | Record<string, unknown> } & Record<
    string,
    unknown
  >
> {
  // `export { onBeforeRender }` defined in `.page.client.js`
  const hook = getHook(pageContext, 'onBeforeRender')
  if (hook) {
    const onBeforeRender = hook.hook
    const pageContextAddendum = {
      _comesDirectlyFromServer: false,
      _pageContextRetrievedFromServer: null,
    }
    const pageContextReadyForRelease = releasePageContext({
      ...pageContext,
      ...pageContextAddendum,
    })
    const hookResult = await onBeforeRender(pageContextReadyForRelease)
    assertHookResult(hookResult, 'onBeforeRender', ['pageContext'], hook.filePath)
    const pageContextFromHook = hookResult?.pageContext
    objectAssign(pageContextAddendum, pageContextFromHook)
    return pageContextAddendum
  }

  // `export { onBeforeRender }` defined in `.page.server.js`
  else if (
    (await analyzePageServerSide(pageContext._pageFilesAll, pageContext._pageId)).hasOnBeforeRenderServerSideOnlyHook
  ) {
    const pageContextFromServer = await retrievePageContextFromServer(pageContext)
    const pageContextAddendum = {}
    Object.assign(pageContextAddendum, pageContextFromServer)
    objectAssign(pageContextAddendum, {
      _comesDirectlyFromServer: true,
      _pageContextRetrievedFromServer: pageContextFromServer,
    })
    return pageContextAddendum
  }

  // No `export { onBeforeRender }` defined
  const pageContextAddendum = { _comesDirectlyFromServer: false, _pageContextRetrievedFromServer: null }
  return pageContextAddendum
}

async function getPageContextFromRoute(
  pageContext: PageContextForRoute,
): Promise<{ _pageId: string; routeParams: Record<string, string> }> {
  const routeResult = await route(pageContext)
  const pageContextFromRoute = routeResult.pageContextAddendum
  if (!pageContextFromRoute._pageId) {
    throw new Error('No routing match')
  }
  assert(hasProp(pageContextFromRoute, '_pageId', 'string'))
  return pageContextFromRoute
}

async function retrievePageContextFromServer(pageContext: { url: string }): Promise<Record<string, unknown>> {
  const pageContextUrl = getFileUrl(pageContext.url, '.pageContext.json', true)
  const response = await fetch(pageContextUrl)

  {
    const contentType = response.headers.get('content-type')
    const isRightContentType = contentType && contentType.includes('application/json')

    // Static hosts + page doesn't exist
    if (!isRightContentType && response.status === 404) {
      serverSideRouteTo(pageContext.url)
      const err = new Error("Page doesn't exist")
      Object.assign(err, { _abortRendering: true })
      throw err
    }

    assertUsage(
      isRightContentType,
      `Wrong HTTP Response Header \`content-type\` value for URL ${pageContextUrl} (it should be \`application/json\` but we got \`${contentType}\`). Make sure to use \`pageContext.httpResponse.contentType\`, see https://github.com/brillout/vite-plugin-ssr/issues/191`,
    )
  }

  const responseText = await response.text()
  const responseObject = parse(responseText) as { pageContext: Record<string, unknown> } | { serverSideError: true }
  if ('serverSideError' in responseObject) {
    throw getProjectError(
      '`pageContext` could not be fetched from the server as an error occurred on the server; check your server logs.',
    )
  }

  assert(hasProp(responseObject, 'pageContext'))
  const pageContextFromServer = responseObject.pageContext
  assert(isPlainObject(pageContextFromServer))
  assert(hasProp(pageContextFromServer, '_pageId', 'string'))

  removeBuiltInOverrides(pageContextFromServer)

  return pageContextFromServer
}
