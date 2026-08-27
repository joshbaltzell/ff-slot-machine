/**
 * The service worker does exactly one job: open the analysis page.
 *
 * Fetching deliberately does NOT live here. MV3 terminates idle service workers
 * after ~30s and pulling a full season takes longer, so the page fetches for
 * itself - extension pages carry the same host permissions, CORS-free and with
 * cookies attached, without the termination risk.
 *
 * A full tab rather than the side panel: the trade table is twelve columns wide
 * and a ~400px side panel cannot show it.
 */
chrome.action.onClicked.addListener(async (tab) => {
  const url = chrome.runtime.getURL("panel.html")
    + (tab?.url ? "?from=" + encodeURIComponent(tab.url) : "");
  await chrome.tabs.create({ url });
});
