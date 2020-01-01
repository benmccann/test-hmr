import * as path from 'path'

const isUrlRoot = url => url.slice(0, 1) === '/'

// http://foo.biz/about/me => http://foo.biz/
const getBaseUrl = url => /^\w*:\/\/[^/]*\//.exec(url)[0]

export const goto = url => async ({ page }) => {
  const pageUrl = await page.url()
  const baseUrl = isUrlRoot(url) ? getBaseUrl(pageUrl) : pageUrl
  const targetUrl = path.posix.join(baseUrl, url)
  await page.goto(targetUrl)
}

export const gotoState = url => async ({ page }) => {
  // eslint-disable-next-line no-undef
  await page.evaluate(url => window.history.pushState({}, '', url), url)
}

goto.push = gotoState

export const breakpoint = () => async ({ page }) => {
  const code = '// You are here because of breakpoint command\ndebugger'
  await page.evaluate(code)
}
