/**
 * dsh-queue-reorder — browser half.
 *
 * Reorder controls live *inside* the official queue dock rows: each queued row
 * gains ↑ / ↓ buttons styled exactly like the dock's own action buttons, and
 * the row itself becomes draggable. Nothing is re-rendered or replaced — the
 * official dock keeps rendering, this only decorates its rows — so previews,
 * editing, steering, removal and image thumbnails stay exactly as shipped.
 *
 * The move is not a client mutation: it is one POST to this plugin's host
 * route, which performs a single concurrency-checked inbox splice. The official
 * queue stream repaints; the decorator re-syncs from the DOM.
 *
 * A hand-authored module-loader bundle: no build step, no React render of its
 * own. The slot entry exists only to read the session snapshot (which row ids
 * exist, in what order) and renders nothing.
 */
window.__ModuleLoader__.load({
	id: "dsh-queue-reorder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Same-origin route registered by the host half. */
		const ROUTE_PATH = "/queue-reorder";
		/** Marks every node this decorator owns, so cleanup and idempotence are exact. */
		const OWNED = "data-queue-reorder";
		/** The official dock's root, as the conversation plugin renders it. */
		const DOCK_SELECTOR = "[data-queue-dock]";
		/** Official pending-submission echoes carry this; they have no inbox id yet. */
		const ECHO_ATTRIBUTE = "data-submission-echo";

		const ARROW_UP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12.6V3.4M8 3.4L4.1 7.3M8 3.4L11.9 7.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		const ARROW_DOWN = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3.4V12.6M8 12.6L4.1 8.7M8 12.6L11.9 8.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		/** Six-dot drag handle, drawn in the same 14px box as the dock's own icons. */
		const GRIP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></svg>';
		/** Dashed marker on the row a drag is currently over. */
		const DROP_OUTLINE = "1px dashed var(--dsw-alias-label-tertiary, #8a8a8a)";

		/** Live dock state: what the session snapshot says, and where to report errors. */
		const state = {
			sessionId: undefined,
			ids: [],
			mutable: false,
			notify: null,
			dragging: -1,
			dropRow: null,
			inflight: false,
		};

		/**
		 * Pure move: the id order after moving one row, or null when nothing moves.
		 * @param ids - current queued ids in order.
		 * @param from - source index.
		 * @param to - target index.
		 * @returns the new order, or null.
		 */
		function nextOrder(ids, from, to) {
			if (from === to || from < 0 || to < 0 || from >= ids.length || to >= ids.length) return null;
			const order = [...ids];
			const [moving] = order.splice(from, 1);
			order.splice(to, 0, moving);
			return order;
		}

		/** @returns the message from any thrown value. */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/** Report a refusal through the dock's own notice channel when it is available. */
		function report(text) {
			if (typeof state.notify === "function") state.notify("error", text);
			else if (typeof console !== "undefined") console.warn("queue-reorder: " + text);
		}

		/**
		 * Ask the host to move one queued message.
		 * @param from - source index.
		 * @param to - target index.
		 */
		async function move(from, to) {
			const order = nextOrder(state.ids, from, to);
			if (order === null || state.inflight) return;
			const itemId = state.ids[from];
			state.inflight = true;
			try {
				const response = await fetch(ROUTE_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						sessionId: state.sessionId,
						itemId,
						toIndex: to,
						expectedOrder: [...state.ids],
					}),
				});
				if (response.ok) return;
				const body = await response.json().catch(() => null);
				const message = body !== null && typeof body === "object" && body.error !== null && typeof body.error === "object"
					? String(body.error.message ?? "reorder refused")
					: "reorder refused (" + String(response.status) + ")";
				report(message);
			}
			catch (error) {
				report(messageOf(error));
			}
			finally {
				state.inflight = false;
			}
		}

		/** @returns the dock's queued rows, in render order, excluding pending echoes. */
		function dockRows() {
			if (typeof document === "undefined") return [];
			const dock = document.querySelector(DOCK_SELECTOR);
			if (dock === null) return [];
			const list = dock.querySelector("ul");
			if (list === null) return [];
			return [...list.children].filter((node) => node.tagName === "LI" && !node.hasAttribute(ECHO_ATTRIBUTE));
		}

		/** @returns the row's action container, or null while the dock renders none. */
		function actionsOf(row) {
			const last = row.lastElementChild;
			return last !== null && last.tagName === "DIV" ? last : null;
		}

		/**
		 * Build one icon button wearing the dock's own action-button classes, so it
		 * is indistinguishable from the buttons the official dock ships.
		 * @param actions - the row's action container (class donor).
		 * @param label - accessible label and tooltip.
		 * @param svg - icon markup.
		 * @returns the button.
		 */
		function makeButton(actions, label, svg) {
			const donor = actions.querySelector("button");
			const button = document.createElement("button");
			button.type = "button";
			if (donor !== null) button.className = donor.className;
			button.innerHTML = svg;
			button.title = label;
			button.setAttribute("aria-label", label);
			button.setAttribute(OWNED, "control");
			return button;
		}

		/** Remove the drag-over marker from whichever row currently wears it. */
		function clearDropMark() {
			if (state.dropRow === null) return;
			state.dropRow.style.outline = "";
			state.dropRow.style.outlineOffset = "";
			state.dropRow = null;
		}

		/** Strip every node and handler this decorator added, leaving the dock as shipped. */
		function clearDecorations() {
			clearDropMark();
			if (typeof document === "undefined") return;
			for (const node of document.querySelectorAll("[" + OWNED + "]")) node.remove();
			for (const row of dockRows()) {
				row.draggable = false;
				row.ondragstart = null;
				row.ondragover = null;
				row.ondrop = null;
				row.ondragend = null;
			}
		}

		/** Decorate every queued row: ↑/↓ in its action strip, and the row itself draggable. */
		function sync() {
			if (typeof document === "undefined") return;
			const rows = dockRows();
			if (state.ids.length < 2 || rows.length !== state.ids.length || !state.mutable) {
				clearDecorations();
				return;
			}
			rows.forEach((row, index) => {
				const actions = actionsOf(row);
				if (actions === null) return;
				const editing = actions.querySelector("input") !== null;
				/**
				 * The row's position, read at event time. The host reorders these very
				 * elements in place, so an index captured when the controls were created
				 * goes stale after the first successful move.
				 * @returns the row's current index, or -1 once it left the dock.
				 */
				const currentIndex = () => dockRows().indexOf(row);
				let grip = row.querySelector("[" + OWNED + '="grip"]');
				if (grip === null) {
					grip = document.createElement("span");
					grip.setAttribute(OWNED, "grip");
					grip.innerHTML = GRIP;
					grip.title = "Drag to reorder";
					grip.style.cssText = "display:inline-flex;flex:none;align-items:center;cursor:grab;color:var(--dsw-alias-label-tertiary,#8a8a8a)";
					grip.draggable = true;
					row.prepend(grip);
				}
				let group = actions.querySelector("[" + OWNED + "]");
				if (group === null) {
					group = document.createElement("span");
					group.setAttribute(OWNED, "group");
					group.style.display = "contents";
					const up = makeButton(actions, "Move earlier", ARROW_UP);
					const down = makeButton(actions, "Move later", ARROW_DOWN);
					up.addEventListener("click", () => { const at = currentIndex(); void move(at, at - 1); });
					down.addEventListener("click", () => { const at = currentIndex(); void move(at, at + 1); });
					group.append(up, down);
					actions.prepend(group);
				}
				// Ends are recomputed on every sync: a queue that grew or was reordered
				// changes which row is first and last, and a stale disabled button is
				// exactly the "I cannot move this one" dead end.
				const controls = group.children;
				if (controls.length === 2) {
					controls[0].disabled = index === 0;
					controls[1].disabled = index === rows.length - 1;
				}
				row.ondragstart = (event) => {
					if (editing) return;
					const at = currentIndex();
					state.dragging = at;
					event.dataTransfer?.setData("text/plain", String(at));
					if (event.dataTransfer != null) event.dataTransfer.effectAllowed = "move";
					row.style.opacity = "0.5";
				};
				row.ondragend = () => {
					clearDropMark();
					row.style.opacity = "";
					state.dragging = -1;
				};
				row.ondragover = (event) => {
					event.preventDefault();
					if (event.dataTransfer != null) event.dataTransfer.dropEffect = "move";
					if (state.dropRow !== row) {
						clearDropMark();
						state.dropRow = row;
						row.style.outline = DROP_OUTLINE;
						row.style.outlineOffset = "-1px";
					}
				};
				row.ondragleave = () => {
					if (state.dropRow === row) clearDropMark();
				};
				row.ondrop = (event) => {
					event.preventDefault();
					clearDropMark();
					const carried = Number(event.dataTransfer?.getData("text/plain"));
					const from = Number.isSafeInteger(carried) && carried >= 0 ? carried : state.dragging;
					state.dragging = -1;
					void move(from, currentIndex());
				};
				row.draggable = !editing;
			});
		}

		/** Coalesce DOM-change storms into one sync per frame. */
		let scheduled = false;
		function scheduleSync() {
			if (scheduled) return;
			scheduled = true;
			const run = () => { scheduled = false; sync(); };
			if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
			else setTimeout(run, 0);
		}

		/**
		 * Slot bridge: reads the authoritative queue for the visible session and
		 * renders nothing. It is the only way a plugin learns which inbox ids the
		 * official rows correspond to, since the dock's DOM carries no ids.
		 * @param props - slot runtime props plus this entry's injected notify.
		 * @returns null, always.
		 */
		function QueueReorderBridge(props) {
			const inbox = typeof props.useSession === "function" ? props.useSession((snapshot) => snapshot.queue) : undefined;
			const mutable = typeof props.useSession === "function"
				? props.useSession((snapshot) => snapshot.subagent === null || (snapshot.subagent.address?.mode === "continuable"))
				: undefined;
			state.sessionId = props.sessionId;
			state.notify = typeof props.notify === "function" ? props.notify : null;
			state.ids = Array.isArray(inbox)
				? inbox.filter((row) => row !== null && typeof row === "object" && row.placement === "queued").map((row) => String(row.id))
				: [];
			state.mutable = mutable === undefined ? true : mutable === true;
			scheduleSync();
			return null;
		}

		/** Client services this plugin reads. */
		const inject = ["slots", "sessions"];

		/**
		 * Watch the dock and register the bridge.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
				const observer = new MutationObserver(() => { scheduleSync(); });
				observer.observe(document.body, { childList: true, subtree: true });
				scheduleSync();
				return () => {
					observer.disconnect();
					clearDecorations();
					state.ids = [];
				};
			}, "queue-reorder: dock decoration");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "queue-reorder",
				order: 1000,
				inject: (sessionId) => {
					const actx = ctx.sessions.scope(sessionId);
					const conversation = actx?.get("conversation");
					return {
						notify: (level, text) => {
							conversation?.input?.for(actx)?.notify?.(level, text);
						},
					};
				},
			}, QueueReorderBridge));
		}

		exports.nextOrder = nextOrder;
		exports.queueState = state;
		exports.QueueReorderBridge = QueueReorderBridge;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
