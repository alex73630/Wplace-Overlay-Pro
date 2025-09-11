/// <reference types="tampermonkey" />

import { urlToDataURL } from "./core/gm"
import { ensureHook, setUpdateUI } from "./core/hook"
import { displayImageFromData } from "./core/overlay"
import { enablePaletteSymbols } from "./core/palette-inject"
import { applyTheme, config, loadConfig } from "./core/store"
import { showToast } from "./core/toast"
import { createUI, updateUI } from "./ui/panel"
import { injectStyles } from "./ui/styles"

async function applyTemplateFromUrl() {
	const urlParams = new URLSearchParams(window.location.search)
	const templateUrl = urlParams.get("template")
	if (!templateUrl) return

	try {
		console.log(`Fetching template from URL: ${templateUrl}`)
		const res = await fetch(templateUrl)
		if (!res.ok) {
			const errorText = await res.text()
			throw new Error(`Failed to fetch template: ${res.status} ${res.statusText} - ${errorText}`)
		}
		const json = await res.json()

		if (!json.record || !json.record.imageUrl) {
			throw new Error("Invalid template format: missing `record.imageUrl`")
		}
		const { name, imageUrl, pixelUrl, offsetX, offsetY, opacity } = json.record

		if (config.overlays.some((o) => o.name === name || o.imageUrl === imageUrl)) {
			return
		}

		console.log(`Fetching image from: ${imageUrl}`)
		const imageBase64 = await urlToDataURL(imageUrl)

		const newOverlay = {
			id: crypto.randomUUID(),
			name,
			enabled: true,
			imageUrl,
			isLocal: false,
			imageBase64,
			pixelUrl,
			offsetX,
			offsetY,
			opacity
		}

		console.log("Adding new overlay from URL template:", newOverlay)
		await displayImageFromData(newOverlay)
		showToast(`Template "${name}" loaded from URL`, "success")
	} catch (err) {
		console.error("Error loading template from URL:", err)
		showToast(`Error: ${err.message}`, "error")
	}
}

export async function bootstrapApp() {
	injectStyles()
	await loadConfig()
	applyTheme()
	createUI()
	setUpdateUI(() => updateUI())
	ensureHook()
	enablePaletteSymbols()
	await applyTemplateFromUrl()
	console.log("Overlay Pro UI ready.")
}
