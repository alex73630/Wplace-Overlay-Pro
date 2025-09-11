export async function generateMeta() {
	let VERSION = process.env.VERSION

	if (VERSION.startsWith("v")) {
		VERSION = VERSION.slice(1)
	}

	if (!VERSION) {
		console.warn("Missing VERSION environment variable. Setting it to current package.json version")

		const packageJson = await import("../package.json", {
			with: { type: "json" }
		})
		VERSION = packageJson.default.version
	}

	const meta = `// ==UserScript==
// @name         Wplace Overlay Pro
// @namespace    http://tampermonkey.net/
// @version      ${VERSION}
// @description  Overlays tiles on wplace.live. Can also resize, and color-match your overlay to wplace's palette. Make sure to comply with the site's Terms of Service, and rules! This script is not affiliated with Wplace.live in any way, use at your own risk. This script is not affiliated with TamperMonkey. The author of this userscript is not responsible for any damages, issues, loss of data, or punishment that may occur as a result of using this script. This script is provided "as is" under GPLv3.
// @author       shinkonet (fork by alex73630)
// @match        https://wplace.live/*
// @license      GPLv3
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// @downloadURL  https://github.com/alex73630/Wplace-Overlay-Pro/releases/download/v${VERSION}/Wplace.Overlay.Pro.user.js
// @updateURL    https://github.com/alex73630/Wplace-Overlay-Pro/releases/latest/download/Wplace.Overlay.Pro.meta.js
// ==/UserScript==
`

	console.log(`[generateMeta] Generated metadata for version ${VERSION}`)
	return meta
}
