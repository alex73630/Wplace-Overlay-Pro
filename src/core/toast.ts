import { config } from "./store"

export function showToast(message: string, type: "info" | "error" | "success" = "info", duration = 3000) {
	let stack = document.getElementById("op-toast-stack")
	if (!stack) {
		stack = document.createElement("div")
		stack.className = "op-toast-stack"
		stack.id = "op-toast-stack"
		document.body.appendChild(stack)
	}
	stack.classList.toggle("op-dark", config.theme === "dark")

	const t = document.createElement("div")
	t.className = `op-toast op-toast-${type}`
	t.textContent = message
	stack.appendChild(t)
	requestAnimationFrame(() => t.classList.add("show"))
	setTimeout(() => {
		t.classList.remove("show")
		setTimeout(() => t.remove(), 200)
	}, duration)
}
