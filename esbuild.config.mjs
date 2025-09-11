import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import esbuild from "esbuild"
import { generateMeta } from "./src/generateMeta.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEV = process.argv.includes("--watch")
const outFile = resolve(__dirname, "dist", "Wplace.Overlay.Pro.user.js")
const outMetaFile = resolve(__dirname, "dist", "Wplace.Overlay.Pro.meta.js")

// Plugin: prepend metadata banner after each build using generateMeta
const MetaBannerPlugin = {
	name: "meta-banner",
	setup(build) {
		build.onEnd(async () => {
			try {
				await mkdir(dirname(outFile), { recursive: true })
				// Use generateMeta to get the banner string
				const meta = await generateMeta()
				const js = await readFile(outFile, "utf8")
				const banner = `${meta.trim()}\n`
				await writeFile(outFile, (banner + js).replace(/\r\n/g, "\n"), "utf8")
			} catch (err) {
				console.error("[meta-banner] Failed to prepend metadata:", err)
			}
		})
	}
}

const buildOptions = {
	entryPoints: [resolve(__dirname, "src", "main.ts")],
	outfile: outFile,
	bundle: true,
	minify: false,
	legalComments: "none",
	target: ["es2021"],
	format: "iife",
	sourcemap: false,
	logLevel: "info",
	plugins: [MetaBannerPlugin]
}

async function buildOnce() {
	await esbuild.build(buildOptions)
	// Write meta file using generateMeta
	const meta = await generateMeta()
	await writeFile(outMetaFile, meta, "utf8")
	console.log("[build] Done.")
}

async function buildAndWatch() {
	const ctx = await esbuild.context(buildOptions)
	await ctx.watch()
	console.log("[watch] Building and watching for changes...")
}

if (DEV) {
	await buildAndWatch()
} else {
	await buildOnce()
}
