import {
	TextFileView,
	Plugin,
	WorkspaceLeaf,
	TFile,
	Menu,
	TFolder,
	Notice,
	Modal,
	Setting,
	MarkdownRenderer,
	Component,
} from "obsidian";

const VIEW_TYPE_RABBITMAP = "rabbitmap-canvas";
const FILE_EXTENSION = "rabbitmap";

interface CanvasNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	type: "card" | "chat";
	content: string;
	title?: string;
}

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	contextFiles?: string[]; // Context files at the time of sending (for user messages)
}

interface Edge {
	id: string;
	from: string;
	to: string;
}

interface ProviderConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	models: string[];
	enabled: boolean;
	apiFormat: "openai" | "anthropic" | "google";
}

interface PluginSettings {
	openaiApiKey: string; // deprecated, kept for migration
	openrouterApiKey: string; // deprecated, kept for migration
	customOpenRouterModels: string;
	providers: ProviderConfig[];
}

const DEFAULT_SETTINGS: PluginSettings = {
	openaiApiKey: "",
	openrouterApiKey: "",
	customOpenRouterModels: "",
	providers: [
		{
			name: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "",
			models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
			enabled: true,
			apiFormat: "openai"
		},
		{
			name: "OpenRouter",
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "",
			models: ["anthropic/claude-3.5-sonnet", "anthropic/claude-3-opus", "openai/gpt-4o", "google/gemini-pro-1.5"],
			enabled: true,
			apiFormat: "openai"
		},
		{
			name: "Anthropic",
			baseUrl: "https://api.anthropic.com",
			apiKey: "",
			models: ["claude-sonnet-4-5", "claude-sonnet-4-5-thinking", "claude-opus-4-5-thinking"],
			enabled: true,
			apiFormat: "anthropic"
		},
		{
			name: "Google",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			apiKey: "",
			models: ["gemini-2.5-flash", "gemini-2.5-flash-thinking", "gemini-3-flash", "gemini-3-pro-high", "gemini-3-pro-low"],
			enabled: true,
			apiFormat: "google"
		}
	]
};

interface ChatNodeState {
	provider: string;
	model: string;
	contextFiles: string[]; // file paths
	systemPrompt: string;
	contextTemplate: string; // template for context files
}

const DEFAULT_CONTEXT_TEMPLATE = `--- {filepath} ---
{content}`;

const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant. You help users with their questions and tasks. When context files are provided, use them to give more accurate and relevant answers. Be concise but thorough.`;

interface RabbitMapData {
	nodes: CanvasNode[];
	edges: Edge[];
	chatMessages: Record<string, ChatMessage[]>;
	chatStates: Record<string, ChatNodeState>;
	view: {
		scale: number;
		panX: number;
		panY: number;
	};
}

class RabbitMapView extends TextFileView {
	private canvas: HTMLElement;
	private nodesContainer: HTMLElement;
	private nodes: Map<string, CanvasNode> = new Map();
	private nodeElements: Map<string, HTMLElement> = new Map();

	// Canvas transform state
	private scale = 1;
	private panX = 0;
	private panY = 0;

	// Interaction state
	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private spacePressed = false;

	// Drag state
	private draggedNode: string | null = null;
	private dragOffsetX = 0;
	private dragOffsetY = 0;

	// Resize state
	private resizingNode: string | null = null;
	private resizeStartWidth = 0;
	private resizeStartHeight = 0;
	private resizeStartX = 0;
	private resizeStartY = 0;

	// Selection state
	private selectedNodes: Set<string> = new Set();
	private isSelecting = false;
	private selectionBox: HTMLElement | null = null;
	private selectionStartX = 0;
	private selectionStartY = 0;
	private dragStartPositions: Map<string, { x: number; y: number }> = new Map();
	private dragStartMouseX = 0;
	private dragStartMouseY = 0;

	// Minimap
	private minimap: HTMLElement;
	private minimapContent: HTMLElement;
	private minimapViewport: HTMLElement;
	private minimapNodes: Map<string, HTMLElement> = new Map();

	// Chat state
	private chatMessages: Map<string, ChatMessage[]> = new Map();
	private chatStates: Map<string, ChatNodeState> = new Map();

	// Edges
	private edges: Map<string, Edge> = new Map();
	private edgesContainer: SVGSVGElement;

	// Plugin reference
	plugin: RabbitMapPlugin;

	private isLoaded = false;
	private isSaving = false;
	private saveTimeout: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: RabbitMapPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_RABBITMAP;
	}

	getDisplayText(): string {
		return this.file?.basename || "RabbitMap";
	}

	getIcon(): string {
		return "layout-dashboard";
	}

	// Called by Obsidian to get current data for saving
	getViewData(): string {
		const data: RabbitMapData = {
			nodes: Array.from(this.nodes.values()),
			edges: Array.from(this.edges.values()),
			chatMessages: Object.fromEntries(this.chatMessages),
			chatStates: Object.fromEntries(this.chatStates),
			view: {
				scale: this.scale,
				panX: this.panX,
				panY: this.panY,
			},
		};
		return JSON.stringify(data, null, 2);
	}

	// Called by Obsidian when file content is loaded
	setViewData(data: string, clear: boolean): void {
		// Ignore if we triggered the save ourselves
		if (this.isSaving) {
			return;
		}

		if (clear) {
			this.clear();
		}

		try {
			if (data.trim()) {
				const parsed: RabbitMapData = JSON.parse(data);

				// Restore view state
				if (parsed.view) {
					this.scale = parsed.view.scale || 1;
					this.panX = parsed.view.panX || 0;
					this.panY = parsed.view.panY || 0;
				}

				// Restore chat messages
				if (parsed.chatMessages) {
					for (const [nodeId, messages] of Object.entries(parsed.chatMessages)) {
						this.chatMessages.set(nodeId, messages);
					}
				}

				// Restore chat states
				if (parsed.chatStates) {
					for (const [nodeId, state] of Object.entries(parsed.chatStates)) {
						this.chatStates.set(nodeId, state as ChatNodeState);
					}
				}

				// Restore nodes
				if (parsed.nodes && parsed.nodes.length > 0) {
					for (const node of parsed.nodes) {
						this.nodes.set(node.id, node);
						this.renderNode(node);
					}
				}

				// Restore edges
				if (parsed.edges && parsed.edges.length > 0) {
					for (const edge of parsed.edges) {
						this.edges.set(edge.id, edge);
					}
					this.renderAllEdges();
				}
			}
		} catch (e) {
			console.log("Error parsing rabbitmap file:", e);
		}

		// If no nodes after loading, add a default chat
		if (this.nodes.size === 0) {
			this.addNode({
				id: this.generateId(),
				x: 100,
				y: 100,
				width: 400,
				height: 500,
				type: "chat",
				content: "",
			}, false); // Don't trigger save on initial load
		}

		this.updateTransform();
		this.isLoaded = true;
	}

	clear(): void {
		this.nodes.clear();
		this.chatMessages.clear();
		this.chatStates.clear();
		this.edges.clear();
		this.nodeElements.forEach((el) => el.remove());
		this.nodeElements.clear();
		if (this.edgesContainer) {
			this.edgesContainer.innerHTML = "";
		}
		this.scale = 1;
		this.panX = 0;
		this.panY = 0;
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("rabbitmap-container");

		// Create canvas
		this.canvas = container.createDiv({ cls: "rabbitmap-canvas" });

		// Create SVG for edges
		this.edgesContainer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.edgesContainer.addClass("rabbitmap-edges");
		this.canvas.appendChild(this.edgesContainer);

		this.nodesContainer = this.canvas.createDiv({ cls: "rabbitmap-nodes" });

		// Create selection box
		this.selectionBox = this.canvas.createDiv({ cls: "rabbitmap-selection-box" });
		this.selectionBox.style.display = "none";

		// Create toolbar
		this.createToolbar(container);

		// Create minimap
		this.createMinimap(container);

		// Setup event listeners
		this.setupEventListeners();

		this.updateTransform();
	}

	private triggerSave(): void {
		if (!this.isLoaded || !this.file) return;

		// Debounce saves
		if (this.saveTimeout) {
			window.clearTimeout(this.saveTimeout);
		}

		this.saveTimeout = window.setTimeout(async () => {
			if (!this.file) return;

			this.isSaving = true;
			await this.app.vault.modify(this.file, this.getViewData());
			// Reset flag after a short delay to catch any setViewData calls
			setTimeout(() => {
				this.isSaving = false;
			}, 100);
		}, 300);
	}

	private createMinimap(container: Element): void {
		this.minimap = container.createDiv({ cls: "rabbitmap-minimap" });
		this.minimapContent = this.minimap.createDiv({ cls: "rabbitmap-minimap-content" });
		this.minimapViewport = this.minimap.createDiv({ cls: "rabbitmap-minimap-viewport" });

		// Click on minimap to navigate
		this.minimap.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.navigateFromMinimap(e);
		});

		this.minimap.addEventListener("mousemove", (e) => {
			if (e.buttons === 1) {
				this.navigateFromMinimap(e);
			}
		});
	}

	private navigateFromMinimap(e: MouseEvent): void {
		const bounds = this.getContentBounds();
		if (!bounds) return;

		const rect = this.minimap.getBoundingClientRect();
		const canvasRect = this.canvas.getBoundingClientRect();

		// Click position relative to minimap
		const clickX = e.clientX - rect.left;
		const clickY = e.clientY - rect.top;

		// Minimap dimensions
		const minimapWidth = rect.width;
		const minimapHeight = rect.height;

		// Content bounds with padding
		const padding = 50;
		const contentWidth = bounds.maxX - bounds.minX + padding * 2;
		const contentHeight = bounds.maxY - bounds.minY + padding * 2;

		// Scale from minimap to canvas
		const minimapScale = Math.min(minimapWidth / contentWidth, minimapHeight / contentHeight);

		// Offset for centering content in minimap
		const contentScaledWidth = contentWidth * minimapScale;
		const contentScaledHeight = contentHeight * minimapScale;
		const offsetX = (minimapWidth - contentScaledWidth) / 2;
		const offsetY = (minimapHeight - contentScaledHeight) / 2;

		// Convert click to canvas coordinates
		const canvasX = (clickX - offsetX) / minimapScale + bounds.minX - padding;
		const canvasY = (clickY - offsetY) / minimapScale + bounds.minY - padding;

		// Center view on clicked point
		this.panX = canvasRect.width / 2 - canvasX * this.scale;
		this.panY = canvasRect.height / 2 - canvasY * this.scale;

		// Clamp pan
		const clamped = this.clampPan(this.panX, this.panY);
		this.panX = clamped.x;
		this.panY = clamped.y;

		this.updateTransform();
		this.triggerSave();
	}

	private updateMinimap(): void {
		if (!this.minimap) return;

		const bounds = this.getContentBounds();
		if (!bounds) {
			this.minimapViewport.style.display = "none";
			return;
		}

		const canvasRect = this.canvas.getBoundingClientRect();
		const minimapRect = this.minimap.getBoundingClientRect();

		// Content bounds with padding
		const padding = 50;
		const contentMinX = bounds.minX - padding;
		const contentMinY = bounds.minY - padding;
		const contentWidth = bounds.maxX - bounds.minX + padding * 2;
		const contentHeight = bounds.maxY - bounds.minY + padding * 2;

		// Scale to fit in minimap
		const minimapScale = Math.min(
			minimapRect.width / contentWidth,
			minimapRect.height / contentHeight
		);

		// Offset for centering
		const contentScaledWidth = contentWidth * minimapScale;
		const contentScaledHeight = contentHeight * minimapScale;
		const offsetX = (minimapRect.width - contentScaledWidth) / 2;
		const offsetY = (minimapRect.height - contentScaledHeight) / 2;

		// Update minimap nodes
		for (const [nodeId, node] of this.nodes) {
			let minimapNode = this.minimapNodes.get(nodeId);
			if (!minimapNode) {
				minimapNode = this.minimapContent.createDiv({ cls: "rabbitmap-minimap-node" });
				if (node.type === "chat") {
					minimapNode.addClass("rabbitmap-minimap-node-chat");
				}
				this.minimapNodes.set(nodeId, minimapNode);
			}

			minimapNode.style.left = `${offsetX + (node.x - contentMinX) * minimapScale}px`;
			minimapNode.style.top = `${offsetY + (node.y - contentMinY) * minimapScale}px`;
			minimapNode.style.width = `${node.width * minimapScale}px`;
			minimapNode.style.height = `${node.height * minimapScale}px`;
		}

		// Remove deleted nodes from minimap
		for (const [nodeId, el] of this.minimapNodes) {
			if (!this.nodes.has(nodeId)) {
				el.remove();
				this.minimapNodes.delete(nodeId);
			}
		}

		// Update viewport indicator
		this.minimapViewport.style.display = "block";
		const viewLeft = (-this.panX / this.scale - contentMinX) * minimapScale + offsetX;
		const viewTop = (-this.panY / this.scale - contentMinY) * minimapScale + offsetY;
		const viewWidth = (canvasRect.width / this.scale) * minimapScale;
		const viewHeight = (canvasRect.height / this.scale) * minimapScale;

		this.minimapViewport.style.left = `${viewLeft}px`;
		this.minimapViewport.style.top = `${viewTop}px`;
		this.minimapViewport.style.width = `${viewWidth}px`;
		this.minimapViewport.style.height = `${viewHeight}px`;
	}

	private createToolbar(container: Element): void {
		const toolbar = container.createDiv({ cls: "rabbitmap-toolbar" });

		// Add elements button
		const addCardBtn = toolbar.createEl("button", { cls: "rabbitmap-btn rabbitmap-btn-icon", attr: { title: "Add Card" } });
		addCardBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
		addCardBtn.onclick = () => this.addCardAtCenter();

		const addChatBtn = toolbar.createEl("button", { cls: "rabbitmap-btn rabbitmap-btn-icon", attr: { title: "Add Chat" } });
		addChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
		addChatBtn.onclick = () => this.addChatAtCenter();

		// Separator
		toolbar.createDiv({ cls: "rabbitmap-toolbar-separator" });

		// Settings button
		const settingsBtn = toolbar.createEl("button", { cls: "rabbitmap-btn rabbitmap-btn-icon", attr: { title: "Settings" } });
		settingsBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
		settingsBtn.onclick = () => this.openSettings();
	}

	private openSettings(): void {
		new SettingsModal(this.app, this.plugin).open();
	}

	private setupEventListeners(): void {
		// Mouse wheel / trackpad handling
		this.canvas.addEventListener("wheel", (e) => {
			e.preventDefault();

			// Pinch to zoom (ctrlKey is set for pinch gestures on trackpad)
			if (e.ctrlKey || e.metaKey) {
				const delta = -e.deltaY * 0.01; // Slower zoom
				this.zoomAtPoint(delta, e.clientX, e.clientY);
			} else {
				// Two-finger scroll = pan
				let newPanX = this.panX - e.deltaX;
				let newPanY = this.panY - e.deltaY;

				// Clamp pan to keep content visible
				const clamped = this.clampPan(newPanX, newPanY);
				this.panX = clamped.x;
				this.panY = clamped.y;
				this.updateTransform();
				this.triggerSave();
			}
		});

		// Pan with middle mouse or space + left mouse, or start selection
		this.canvas.addEventListener("mousedown", (e) => {
			if (e.button === 1 || (e.button === 0 && this.spacePressed)) {
				// Panning
				e.preventDefault();
				this.isPanning = true;
				this.panStartX = e.clientX - this.panX;
				this.panStartY = e.clientY - this.panY;
				this.canvas.addClass("panning");
			} else if (e.button === 0 && e.target === this.canvas) {
				// Start selection box (only if clicking on canvas itself, not on nodes)
				e.preventDefault();
				this.isSelecting = true;
				const rect = this.canvas.getBoundingClientRect();
				this.selectionStartX = e.clientX - rect.left;
				this.selectionStartY = e.clientY - rect.top;

				if (this.selectionBox) {
					this.selectionBox.style.left = `${this.selectionStartX}px`;
					this.selectionBox.style.top = `${this.selectionStartY}px`;
					this.selectionBox.style.width = "0px";
					this.selectionBox.style.height = "0px";
					this.selectionBox.style.display = "block";
				}

				// Clear selection if not holding shift
				if (!e.shiftKey) {
					this.clearSelection();
				}
			}
		});

		document.addEventListener("mousemove", (e) => {
			if (this.isPanning) {
				let newPanX = e.clientX - this.panStartX;
				let newPanY = e.clientY - this.panStartY;

				// Clamp pan to keep content visible
				const clamped = this.clampPan(newPanX, newPanY);
				this.panX = clamped.x;
				this.panY = clamped.y;
				this.updateTransform();
			} else if (this.isSelecting && this.selectionBox) {
				// Update selection box
				const rect = this.canvas.getBoundingClientRect();
				const currentX = e.clientX - rect.left;
				const currentY = e.clientY - rect.top;

				const left = Math.min(this.selectionStartX, currentX);
				const top = Math.min(this.selectionStartY, currentY);
				const width = Math.abs(currentX - this.selectionStartX);
				const height = Math.abs(currentY - this.selectionStartY);

				this.selectionBox.style.left = `${left}px`;
				this.selectionBox.style.top = `${top}px`;
				this.selectionBox.style.width = `${width}px`;
				this.selectionBox.style.height = `${height}px`;

				// Update selection based on intersection
				this.updateSelectionFromBox(left, top, width, height);
			} else if (this.draggedNode) {
				const rect = this.canvas.getBoundingClientRect();
				const mouseX = (e.clientX - rect.left - this.panX) / this.scale;
				const mouseY = (e.clientY - rect.top - this.panY) / this.scale;

				// If dragging a selected node, move all selected nodes
				if (this.selectedNodes.has(this.draggedNode) && this.selectedNodes.size > 0) {
					const deltaX = mouseX - this.dragStartMouseX;
					const deltaY = mouseY - this.dragStartMouseY;

					for (const nodeId of this.selectedNodes) {
						const startPos = this.dragStartPositions.get(nodeId);
						if (startPos) {
							this.updateNodePosition(nodeId, startPos.x + deltaX, startPos.y + deltaY);
						}
					}
				} else {
					const x = mouseX - this.dragOffsetX;
					const y = mouseY - this.dragOffsetY;
					this.updateNodePosition(this.draggedNode, x, y);
				}
			} else if (this.resizingNode) {
				const deltaX = (e.clientX - this.resizeStartX) / this.scale;
				const deltaY = (e.clientY - this.resizeStartY) / this.scale;
				const newWidth = Math.max(200, this.resizeStartWidth + deltaX);
				const newHeight = Math.max(150, this.resizeStartHeight + deltaY);
				this.updateNodeSize(this.resizingNode, newWidth, newHeight);
			}
		});

		document.addEventListener("mouseup", () => {
			if (this.isPanning || this.draggedNode || this.resizingNode) {
				this.triggerSave();
			}
			this.isPanning = false;
			this.draggedNode = null;
			this.dragStartPositions.clear();
			this.resizingNode = null;
			this.canvas.removeClass("panning");

			// End selection
			if (this.isSelecting && this.selectionBox) {
				this.isSelecting = false;
				this.selectionBox.style.display = "none";
			}
		});

		// Space key for pan mode
		document.addEventListener("keydown", (e) => {
			if (e.code === "Space" && !this.isInputFocused()) {
				e.preventDefault();
				this.spacePressed = true;
				this.canvas.addClass("pan-mode");
			}
			// Delete selected nodes
			if ((e.code === "Delete" || e.code === "Backspace") && !this.isInputFocused() && this.selectedNodes.size > 0) {
				e.preventDefault();
				this.deleteSelectedNodes();
			}
			// Escape to clear selection
			if (e.code === "Escape" && this.selectedNodes.size > 0) {
				this.clearSelection();
			}
		});

		document.addEventListener("keyup", (e) => {
			if (e.code === "Space") {
				this.spacePressed = false;
				this.canvas.removeClass("pan-mode");
			}
		});
	}

	private updateSelectionFromBox(left: number, top: number, width: number, height: number): void {
		// Convert screen coords to canvas coords
		const boxLeft = (left - this.panX) / this.scale;
		const boxTop = (top - this.panY) / this.scale;
		const boxRight = (left + width - this.panX) / this.scale;
		const boxBottom = (top + height - this.panY) / this.scale;

		for (const [nodeId, node] of this.nodes) {
			const nodeRight = node.x + node.width;
			const nodeBottom = node.y + node.height;

			// Check intersection
			const intersects =
				node.x < boxRight &&
				nodeRight > boxLeft &&
				node.y < boxBottom &&
				nodeBottom > boxTop;

			if (intersects) {
				this.selectNode(nodeId);
			} else {
				this.deselectNode(nodeId);
			}
		}
	}

	private selectNode(nodeId: string): void {
		if (!this.selectedNodes.has(nodeId)) {
			this.selectedNodes.add(nodeId);
			const el = this.nodeElements.get(nodeId);
			if (el) {
				el.addClass("rabbitmap-node-selected");
			}
		}
	}

	private deselectNode(nodeId: string): void {
		if (this.selectedNodes.has(nodeId)) {
			this.selectedNodes.delete(nodeId);
			const el = this.nodeElements.get(nodeId);
			if (el) {
				el.removeClass("rabbitmap-node-selected");
			}
		}
	}

	private clearSelection(): void {
		for (const nodeId of this.selectedNodes) {
			const el = this.nodeElements.get(nodeId);
			if (el) {
				el.removeClass("rabbitmap-node-selected");
			}
		}
		this.selectedNodes.clear();
	}

	private deleteSelectedNodes(): void {
		for (const nodeId of this.selectedNodes) {
			this.nodes.delete(nodeId);
			this.chatMessages.delete(nodeId);
			this.chatStates.delete(nodeId);
			const el = this.nodeElements.get(nodeId);
			if (el) {
				el.remove();
				this.nodeElements.delete(nodeId);
			}
			// Remove edges connected to this node
			for (const [edgeId, edge] of this.edges) {
				if (edge.from === nodeId || edge.to === nodeId) {
					this.edges.delete(edgeId);
				}
			}
		}
		this.selectedNodes.clear();
		this.updateEdges();
		this.updateMinimap();
		this.triggerSave();
	}

	private isInputFocused(): boolean {
		const active = document.activeElement;
		return (
			active instanceof HTMLInputElement ||
			active instanceof HTMLTextAreaElement ||
			(active as HTMLElement)?.isContentEditable
		);
	}

	private zoom(delta: number): void {
		const newScale = Math.min(Math.max(this.scale + delta, 0.5), 2);
		this.scale = newScale;
		this.updateTransform();
		this.triggerSave();
	}

	private zoomAtPoint(delta: number, clientX: number, clientY: number): void {
		const rect = this.canvas.getBoundingClientRect();
		const mouseX = clientX - rect.left;
		const mouseY = clientY - rect.top;

		const oldScale = this.scale;
		const newScale = Math.min(Math.max(this.scale + delta, 0.5), 2);

		if (newScale !== oldScale) {
			this.panX = mouseX - ((mouseX - this.panX) * newScale) / oldScale;
			this.panY = mouseY - ((mouseY - this.panY) * newScale) / oldScale;
			this.scale = newScale;

			this.updateTransform();
			this.triggerSave();
		}
	}

	private resetView(): void {
		this.scale = 1;
		this.panX = 0;
		this.panY = 0;
		this.updateTransform();
		this.triggerSave();
	}

	private getContentBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
		if (this.nodes.size === 0) return null;

		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

		for (const node of this.nodes.values()) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x + node.width);
			maxY = Math.max(maxY, node.y + node.height);
		}

		return { minX, minY, maxX, maxY };
	}

	private clampPan(panX: number, panY: number): { x: number; y: number } {
		const bounds = this.getContentBounds();
		if (!bounds) return { x: panX, y: panY };

		const rect = this.canvas.getBoundingClientRect();
		const viewWidth = rect.width;
		const viewHeight = rect.height;

		// Allow content to go off-screen but keep at least 20% visible
		const keepVisible = 0.2;
		const contentWidth = (bounds.maxX - bounds.minX) * this.scale;
		const contentHeight = (bounds.maxY - bounds.minY) * this.scale;

		// Min visible amount
		const minVisibleX = Math.min(contentWidth * keepVisible, 100);
		const minVisibleY = Math.min(contentHeight * keepVisible, 100);

		const contentLeft = bounds.minX * this.scale;
		const contentRight = bounds.maxX * this.scale;
		const contentTop = bounds.minY * this.scale;
		const contentBottom = bounds.maxY * this.scale;

		// Content can go mostly off-screen but not completely
		const minPanX = minVisibleX - contentRight;
		const maxPanX = viewWidth - minVisibleX - contentLeft;
		const minPanY = minVisibleY - contentBottom;
		const maxPanY = viewHeight - minVisibleY - contentTop;

		return {
			x: Math.min(Math.max(panX, minPanX), maxPanX),
			y: Math.min(Math.max(panY, minPanY), maxPanY),
		};
	}

	private zoomToNode(nodeId: string): void {
		const node = this.nodes.get(nodeId);
		if (!node) return;

		const rect = this.canvas.getBoundingClientRect();
		const viewWidth = rect.width;
		const viewHeight = rect.height;

		// Calculate scale to fit node with padding
		const padding = 100;
		const scaleX = viewWidth / (node.width + padding * 2);
		const scaleY = viewHeight / (node.height + padding * 2);
		const targetScale = Math.min(Math.max(Math.min(scaleX, scaleY), 0.5), 2);

		// Center node in view
		const nodeCenterX = node.x + node.width / 2;
		const nodeCenterY = node.y + node.height / 2;

		const targetPanX = viewWidth / 2 - nodeCenterX * targetScale;
		const targetPanY = viewHeight / 2 - nodeCenterY * targetScale;

		// Animate to target
		this.animateTo(targetScale, targetPanX, targetPanY);
	}

	private showChatContextMenu(nodeId: string, e: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle("Branch")
				.setIcon("git-branch")
				.onClick(() => {
					this.branchChat(nodeId);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Fork")
				.setIcon("git-fork")
				.onClick(() => {
					this.forkChat(nodeId);
				});
		});

		menu.showAtMouseEvent(e);
	}

	private branchChat(nodeId: string, upToMsgIndex?: number): void {
		const sourceNode = this.nodes.get(nodeId);
		const sourceState = this.chatStates.get(nodeId);
		const sourceMessages = this.chatMessages.get(nodeId);
		if (!sourceNode || !sourceState) return;

		// Find free position
		const pos = this.findFreePosition(sourceNode);

		// Create new node with branch suffix
		const baseTitle = sourceNode.title || "Chat";
		const newNode: CanvasNode = {
			id: this.generateId(),
			x: pos.x,
			y: pos.y,
			width: sourceNode.width,
			height: sourceNode.height,
			type: "chat",
			content: "",
			title: `${baseTitle} (branch)`,
		};

		// Copy state
		const newState: ChatNodeState = {
			provider: sourceState.provider,
			model: sourceState.model,
			contextFiles: [...sourceState.contextFiles],
			systemPrompt: sourceState.systemPrompt,
			contextTemplate: sourceState.contextTemplate,
		};

		// Copy messages up to specified index (or all if not specified)
		let newMessages: ChatMessage[] = [];
		if (sourceMessages) {
			if (upToMsgIndex !== undefined) {
				newMessages = sourceMessages.slice(0, upToMsgIndex + 1);
			} else {
				newMessages = [...sourceMessages];
			}
		}

		this.nodes.set(newNode.id, newNode);
		this.chatStates.set(newNode.id, newState);
		this.chatMessages.set(newNode.id, newMessages);
		this.renderNode(newNode);

		// Add edge from source to new node
		this.addEdge(nodeId, newNode.id);

		this.updateMinimap();
		this.triggerSave();

		// Zoom to new node, scroll to last message, and focus input
		this.zoomToNode(newNode.id);
		this.scrollChatToBottom(newNode.id);
		this.focusChatInput(newNode.id);
	}

	private scrollChatToBottom(nodeId: string): void {
		const nodeEl = this.nodeElements.get(nodeId);
		if (!nodeEl) return;

		const messagesContainer = nodeEl.querySelector(".rabbitmap-chat-messages") as HTMLElement;
		if (messagesContainer) {
			// Use setTimeout to ensure DOM is ready after render
			setTimeout(() => {
				messagesContainer.scrollTop = messagesContainer.scrollHeight;
			}, 50);
		}
	}

	private focusChatInput(nodeId: string): void {
		const nodeEl = this.nodeElements.get(nodeId);
		if (!nodeEl) return;

		// Use setTimeout to ensure DOM and animations are ready
		setTimeout(() => {
			const input = nodeEl.querySelector(".rabbitmap-chat-input") as HTMLTextAreaElement;
			if (input) {
				input.focus();
			}
		}, 350); // After zoom animation (300ms)
	}

	// Public methods for ExpandedChatModal
	getNode(nodeId: string): CanvasNode | undefined {
		return this.nodes.get(nodeId);
	}

	getChatState(nodeId: string): ChatNodeState | undefined {
		return this.chatStates.get(nodeId);
	}

	getChatMessages(nodeId: string): ChatMessage[] | undefined {
		return this.chatMessages.get(nodeId);
	}

	private openExpandedChat(nodeId: string): void {
		new ExpandedChatModal(this.app, this, nodeId).open();
	}

	async sendChatMessage(nodeId: string, text: string): Promise<void> {
		const chatState = this.chatStates.get(nodeId);
		if (!chatState) return;

		const msg: ChatMessage = {
			role: "user",
			content: text,
			contextFiles: chatState.contextFiles ? [...chatState.contextFiles] : []
		};

		const messages = this.chatMessages.get(nodeId) || [];
		messages.push(msg);
		this.chatMessages.set(nodeId, messages);

		// Update node UI
		this.refreshChatNode(nodeId);
		this.triggerSave();

		// Get provider
		const provider = this.plugin.settings.providers.find(p => p.name === chatState.provider);
		if (!provider) return;

		// Get API key from provider config (with fallback to legacy fields for migration)
		let apiKey = provider.apiKey || "";
		if (!apiKey) {
			// Fallback to legacy API key fields for backward compatibility
			if (chatState.provider === "OpenAI" && this.plugin.settings.openaiApiKey) {
				apiKey = this.plugin.settings.openaiApiKey;
			} else if (chatState.provider === "OpenRouter" && this.plugin.settings.openrouterApiKey) {
				apiKey = this.plugin.settings.openrouterApiKey;
			}
		}

		if (!apiKey) {
			const errorMsg: ChatMessage = {
				role: "assistant",
				content: `Please set your ${chatState.provider} API key in settings.`,
			};
			messages.push(errorMsg);
			this.refreshChatNode(nodeId);
			this.triggerSave();
			return;
		}

		// Load context
		let contextContent = "";
		if (chatState.contextFiles && chatState.contextFiles.length > 0) {
			const template = chatState.contextTemplate || DEFAULT_CONTEXT_TEMPLATE;
			const contextParts: string[] = [];
			for (const filePath of chatState.contextFiles) {
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file && file instanceof TFile) {
					try {
						const content = await this.app.vault.read(file);
						const formatted = template
							.replace(/\{filepath\}/g, filePath)
							.replace(/\{filename\}/g, file.name)
							.replace(/\{content\}/g, content);
						contextParts.push(formatted);
					} catch {}
				}
			}
			if (contextParts.length > 0) {
				contextContent = "Context files:\n\n" + contextParts.join("\n\n");
			}
		}

		try {
			const response = await this.callLLM(provider, apiKey, chatState.model, messages, contextContent, chatState.systemPrompt || "");
			const assistantMsg: ChatMessage = {
				role: "assistant",
				content: response,
			};
			messages.push(assistantMsg);
			this.refreshChatNode(nodeId);
			this.triggerSave();
		} catch (error) {
			const errorMsg: ChatMessage = {
				role: "assistant",
				content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
			};
			messages.push(errorMsg);
			this.refreshChatNode(nodeId);
			this.triggerSave();
		}
	}

	private refreshChatNode(nodeId: string): void {
		const nodeEl = this.nodeElements.get(nodeId);
		if (!nodeEl) return;

		const messagesContainer = nodeEl.querySelector(".rabbitmap-chat-messages") as HTMLElement;
		if (!messagesContainer) return;

		messagesContainer.empty();
		const messages = this.chatMessages.get(nodeId) || [];
		messages.forEach((msg, index) => {
			this.renderChatMessage(messagesContainer, msg, nodeId, index);
		});
		messagesContainer.scrollTop = messagesContainer.scrollHeight;
	}

	private async exportChatToMd(node: CanvasNode): Promise<void> {
		const messages = this.chatMessages.get(node.id) || [];
		if (messages.length === 0) {
			new Notice("No messages to export");
			return;
		}

		const chatState = this.chatStates.get(node.id);
		const title = node.title || "Chat";

		// Build markdown content
		let md = `# ${title}\n\n`;

		if (chatState) {
			md += `> **Model:** ${chatState.provider} / ${chatState.model}\n\n`;
		}

		md += `---\n\n`;

		for (const msg of messages) {
			if (msg.role === "user") {
				md += `## User\n\n`;
				// Show context for this specific message
				if (msg.contextFiles && msg.contextFiles.length > 0) {
					md += `> **Context:** `;
					md += msg.contextFiles.map(f => `[[${f}]]`).join(", ");
					md += `\n\n`;
				}
				md += `${msg.content}\n\n`;
			} else {
				md += `## Assistant\n\n${msg.content}\n\n`;
			}
		}

		// Get folder path from current file
		const folder = this.file?.parent?.path || "";
		const now = new Date();
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const hours = now.getHours();
		const ampm = hours >= 12 ? "PM" : "AM";
		const hours12 = hours % 12 || 12;
		const timestamp = `${now.getFullYear()} ${months[now.getMonth()]} ${now.getDate()} ${hours12}-${String(now.getMinutes()).padStart(2, "0")} ${ampm}`;
		const fileName = `${title.replace(/[\\/:*?"<>|]/g, "-")} ${timestamp}`;
		const filePath = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;

		const file = await this.app.vault.create(filePath, md);
		new Notice(`Saved to ${filePath}`);

		// Open the file in a new tab
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
	}

	private showTitleEditor(node: CanvasNode, titleSpan: HTMLElement, container: HTMLElement): void {
		const currentTitle = node.title || (node.type === "chat" ? "Chat" : "Card");

		// Hide title span
		titleSpan.style.display = "none";

		// Create input
		const input = container.createEl("input", {
			cls: "rabbitmap-title-input",
			attr: { type: "text", value: currentTitle }
		});
		input.value = currentTitle;
		input.focus();
		input.select();

		const finishEdit = () => {
			const newTitle = input.value.trim();
			if (newTitle && newTitle !== currentTitle) {
				node.title = newTitle;
				titleSpan.setText(newTitle);
				this.triggerSave();
			}
			input.remove();
			titleSpan.style.display = "";
		};

		input.addEventListener("blur", finishEdit);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				input.blur();
			}
			if (e.key === "Escape") {
				input.value = currentTitle;
				input.blur();
			}
		});
	}

	private forkChat(nodeId: string): void {
		const sourceNode = this.nodes.get(nodeId);
		const sourceState = this.chatStates.get(nodeId);
		if (!sourceNode || !sourceState) return;

		// Find free position
		const pos = this.findFreePosition(sourceNode);

		// Create new node with fork suffix
		const baseTitle = sourceNode.title || "Chat";
		const newNode: CanvasNode = {
			id: this.generateId(),
			x: pos.x,
			y: pos.y,
			width: sourceNode.width,
			height: sourceNode.height,
			type: "chat",
			content: "",
			title: `${baseTitle} (fork)`,
		};

		// Copy state (context, prompts, model) but NOT messages
		const newState: ChatNodeState = {
			provider: sourceState.provider,
			model: sourceState.model,
			contextFiles: [...sourceState.contextFiles],
			systemPrompt: sourceState.systemPrompt,
			contextTemplate: sourceState.contextTemplate,
		};

		this.nodes.set(newNode.id, newNode);
		this.chatStates.set(newNode.id, newState);
		this.chatMessages.set(newNode.id, []); // Empty messages
		this.renderNode(newNode);

		// Add edge from source to new node
		this.addEdge(nodeId, newNode.id);

		this.updateMinimap();
		this.triggerSave();

		// Zoom to new node and focus input
		this.zoomToNode(newNode.id);
		this.focusChatInput(newNode.id);
	}

	private findFreePosition(sourceNode: CanvasNode): { x: number; y: number } {
		const gap = 50; // Gap between nodes

		// Try right position first
		const rightX = sourceNode.x + sourceNode.width + gap;
		const rightY = sourceNode.y;

		if (!this.isPositionOccupied(rightX, rightY, sourceNode.width, sourceNode.height)) {
			return { x: rightX, y: rightY };
		}

		// Find blocking node on the right and place below it
		const blockingNode = this.findBlockingNode(rightX, rightY, sourceNode.width, sourceNode.height);
		if (blockingNode) {
			const belowBlockingY = blockingNode.y + blockingNode.height + gap;
			if (!this.isPositionOccupied(rightX, belowBlockingY, sourceNode.width, sourceNode.height)) {
				return { x: rightX, y: belowBlockingY };
			}
		}

		// Keep trying further down on the right side
		let tryY = rightY + sourceNode.height + gap;
		for (let i = 0; i < 5; i++) {
			if (!this.isPositionOccupied(rightX, tryY, sourceNode.width, sourceNode.height)) {
				return { x: rightX, y: tryY };
			}
			const blocker = this.findBlockingNode(rightX, tryY, sourceNode.width, sourceNode.height);
			if (blocker) {
				tryY = blocker.y + blocker.height + gap;
			} else {
				tryY += sourceNode.height + gap;
			}
		}

		// Fallback: offset from source
		return { x: sourceNode.x + 60, y: sourceNode.y + 60 };
	}

	private findBlockingNode(x: number, y: number, width: number, height: number): CanvasNode | null {
		const padding = 20;

		for (const node of this.nodes.values()) {
			const overlaps =
				x < node.x + node.width + padding &&
				x + width + padding > node.x &&
				y < node.y + node.height + padding &&
				y + height + padding > node.y;

			if (overlaps) return node;
		}
		return null;
	}

	private isPositionOccupied(x: number, y: number, width: number, height: number): boolean {
		const padding = 20; // Minimum gap

		for (const node of this.nodes.values()) {
			// Check if rectangles overlap
			const overlaps =
				x < node.x + node.width + padding &&
				x + width + padding > node.x &&
				y < node.y + node.height + padding &&
				y + height + padding > node.y;

			if (overlaps) return true;
		}
		return false;
	}

	private addEdge(fromId: string, toId: string): void {
		const edge: Edge = {
			id: `edge-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			from: fromId,
			to: toId,
		};
		this.edges.set(edge.id, edge);
		this.renderEdge(edge);
	}

	private renderAllEdges(): void {
		// Clear existing edge elements
		this.edgesContainer.innerHTML = "";

		for (const edge of this.edges.values()) {
			this.renderEdge(edge);
		}
	}

	private renderEdge(edge: Edge): void {
		const fromNode = this.nodes.get(edge.from);
		const toNode = this.nodes.get(edge.to);
		if (!fromNode || !toNode) return;

		// Calculate connection points
		const fromCenterX = fromNode.x + fromNode.width / 2;
		const fromCenterY = fromNode.y + fromNode.height / 2;
		const toCenterX = toNode.x + toNode.width / 2;
		const toCenterY = toNode.y + toNode.height / 2;

		// Determine which sides to connect
		let fromX: number, fromY: number, toX: number, toY: number;

		const dx = toCenterX - fromCenterX;
		const dy = toCenterY - fromCenterY;

		const arrowSize = 14;

		if (Math.abs(dx) > Math.abs(dy)) {
			// Horizontal connection
			if (dx > 0) {
				// To is on the right
				fromX = fromNode.x + fromNode.width;
				fromY = fromCenterY;
				toX = toNode.x;
				toY = toCenterY;
			} else {
				// To is on the left
				fromX = fromNode.x;
				fromY = fromCenterY;
				toX = toNode.x + toNode.width;
				toY = toCenterY;
			}
		} else {
			// Vertical connection
			if (dy > 0) {
				// To is below
				fromX = fromCenterX;
				fromY = fromNode.y + fromNode.height;
				toX = toCenterX;
				toY = toNode.y;
			} else {
				// To is above
				fromX = fromCenterX;
				fromY = fromNode.y;
				toX = toCenterX;
				toY = toNode.y + toNode.height;
			}
		}

		// Create group for edge
		const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
		group.setAttribute("id", edge.id);

		// Create path element
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("class", "rabbitmap-edge");

		// Create a curved path
		const midX = (fromX + toX) / 2;
		const midY = (fromY + toY) / 2;

		// Bezier curve control points
		let cx1: number, cy1: number, cx2: number, cy2: number;

		if (Math.abs(dx) > Math.abs(dy)) {
			// Horizontal: curve horizontally
			cx1 = midX;
			cy1 = fromY;
			cx2 = midX;
			cy2 = toY;
		} else {
			// Vertical: curve vertically
			cx1 = fromX;
			cy1 = midY;
			cx2 = toX;
			cy2 = midY;
		}

		const d = `M ${fromX} ${fromY} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${toX} ${toY}`;
		path.setAttribute("d", d);
		group.appendChild(path);

		// Calculate arrow direction from curve end tangent
		// Tangent at t=1 for cubic bezier: 3*(P3-P2) = 3*(toX-cx2, toY-cy2)
		const tangentX = toX - cx2;
		const tangentY = toY - cy2;
		const len = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
		const normX = tangentX / len;
		const normY = tangentY / len;

		// Arrow points
		const arrowTipX = toX;
		const arrowTipY = toY;
		const arrowBaseX = toX - normX * arrowSize;
		const arrowBaseY = toY - normY * arrowSize;

		// Perpendicular for arrow width
		const perpX = -normY * (arrowSize / 2);
		const perpY = normX * (arrowSize / 2);

		const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
		const points = `${arrowTipX},${arrowTipY} ${arrowBaseX + perpX},${arrowBaseY + perpY} ${arrowBaseX - perpX},${arrowBaseY - perpY}`;
		arrow.setAttribute("points", points);
		arrow.setAttribute("class", "rabbitmap-arrow");
		group.appendChild(arrow);

		this.edgesContainer.appendChild(group);
	}

	private updateEdges(): void {
		this.renderAllEdges();
	}

	private animateTo(targetScale: number, targetPanX: number, targetPanY: number): void {
		const startScale = this.scale;
		const startPanX = this.panX;
		const startPanY = this.panY;
		const duration = 300;
		const startTime = performance.now();

		const animate = (currentTime: number) => {
			const elapsed = currentTime - startTime;
			const progress = Math.min(elapsed / duration, 1);

			// Ease out cubic
			const eased = 1 - Math.pow(1 - progress, 3);

			this.scale = startScale + (targetScale - startScale) * eased;
			this.panX = startPanX + (targetPanX - startPanX) * eased;
			this.panY = startPanY + (targetPanY - startPanY) * eased;

			this.updateTransform();

			if (progress < 1) {
				requestAnimationFrame(animate);
			} else {
				this.triggerSave();
			}
		};

		requestAnimationFrame(animate);
	}

	private updateTransform(): void {
		if (this.nodesContainer) {
			this.nodesContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		}
		// Transform edges container same as nodes
		if (this.edgesContainer) {
			this.edgesContainer.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
		}
		// Move grid with pan/zoom
		if (this.canvas) {
			const gridSize = 20 * this.scale;
			this.canvas.style.backgroundSize = `${gridSize}px ${gridSize}px`;
			this.canvas.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
		}
		this.updateMinimap();
	}

	private generateId(): string {
		return "node-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9);
	}

	private addNode(node: CanvasNode, save: boolean = true): void {
		this.nodes.set(node.id, node);

		if (node.type === "chat") {
			if (!this.chatMessages.has(node.id)) {
				this.chatMessages.set(node.id, []);
			}
			if (!this.chatStates.has(node.id)) {
				const defaultProvider = this.plugin.settings.providers[0];
				this.chatStates.set(node.id, {
					provider: defaultProvider.name,
					model: defaultProvider.models[0],
					contextFiles: [],
					systemPrompt: DEFAULT_SYSTEM_PROMPT,
					contextTemplate: DEFAULT_CONTEXT_TEMPLATE
				});
			}
		}

		this.renderNode(node);

		if (save) {
			this.triggerSave();
		}
	}

	private renderNode(node: CanvasNode): void {
		if (!this.nodesContainer) return;

		const el = this.nodesContainer.createDiv({
			cls: `rabbitmap-node rabbitmap-node-${node.type}`,
		});
		el.style.left = `${node.x}px`;
		el.style.top = `${node.y}px`;
		el.style.width = `${node.width}px`;
		el.style.height = `${node.height}px`;

		// Header for dragging
		const header = el.createDiv({ cls: "rabbitmap-node-header" });

		const titleContainer = header.createDiv({ cls: "rabbitmap-node-title-container" });
		const titleSpan = titleContainer.createSpan({
			text: node.title || (node.type === "chat" ? "Chat" : "Card"),
			cls: "rabbitmap-node-title"
		});

		// Edit title button (pencil icon)
		const editTitleBtn = titleContainer.createEl("button", { cls: "rabbitmap-edit-title-btn" });
		editTitleBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

		editTitleBtn.onclick = (e) => {
			e.stopPropagation();
			this.showTitleEditor(node, titleSpan, titleContainer);
		};

		// Export to MD button (only for chat nodes)
		if (node.type === "chat") {
			const exportBtn = titleContainer.createEl("button", { cls: "rabbitmap-export-btn" });
			exportBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
			exportBtn.title = "Save as MD";

			exportBtn.onclick = (e) => {
				e.stopPropagation();
				this.exportChatToMd(node);
			};

			// Expand chat button
			const expandBtn = titleContainer.createEl("button", { cls: "rabbitmap-expand-btn" });
			expandBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
			expandBtn.title = "Expand chat";

			expandBtn.onclick = (e) => {
				e.stopPropagation();
				this.openExpandedChat(node.id);
			};
		}

		// Delete button
		const deleteBtn = header.createEl("button", { text: "×", cls: "rabbitmap-delete-btn" });
		deleteBtn.onclick = (e) => {
			e.stopPropagation();
			this.deleteNode(node.id);
		};

		// Make header draggable
		header.addEventListener("mousedown", (e) => {
			if (e.button === 0 && !this.spacePressed) {
				e.stopPropagation();

				// Handle selection
				if (e.shiftKey) {
					// Toggle selection with shift
					if (this.selectedNodes.has(node.id)) {
						this.deselectNode(node.id);
					} else {
						this.selectNode(node.id);
					}
				} else if (!this.selectedNodes.has(node.id)) {
					// Click on unselected node - clear others and select this one
					this.clearSelection();
					this.selectNode(node.id);
				}

				// Start drag
				this.draggedNode = node.id;
				const rect = el.getBoundingClientRect();
				this.dragOffsetX = (e.clientX - rect.left) / this.scale;
				this.dragOffsetY = (e.clientY - rect.top) / this.scale;

				// Store start mouse position in canvas coords
				const canvasRect = this.canvas.getBoundingClientRect();
				this.dragStartMouseX = (e.clientX - canvasRect.left - this.panX) / this.scale;
				this.dragStartMouseY = (e.clientY - canvasRect.top - this.panY) / this.scale;

				// Store start positions for all selected nodes
				this.dragStartPositions.clear();
				for (const nodeId of this.selectedNodes) {
					const n = this.nodes.get(nodeId);
					if (n) {
						this.dragStartPositions.set(nodeId, { x: n.x, y: n.y });
					}
				}
			}
		});

		// Double-click to zoom to node
		header.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.zoomToNode(node.id);
		});

		// Right-click context menu for chat nodes
		if (node.type === "chat") {
			el.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.showChatContextMenu(node.id, e);
			});
		}

		// Content area
		const content = el.createDiv({ cls: "rabbitmap-node-content" });

		if (node.type === "chat") {
			this.renderChatContent(node.id, content);
		} else {
			this.renderCardContent(node, content);
		}

		// Resize handle
		const resizeHandle = el.createDiv({ cls: "rabbitmap-resize-handle" });
		resizeHandle.addEventListener("mousedown", (e) => {
			if (e.button === 0) {
				e.stopPropagation();
				e.preventDefault();
				this.resizingNode = node.id;
				this.resizeStartWidth = node.width;
				this.resizeStartHeight = node.height;
				this.resizeStartX = e.clientX;
				this.resizeStartY = e.clientY;
			}
		});

		this.nodeElements.set(node.id, el);
	}

	private renderCardContent(node: CanvasNode, container: HTMLElement): void {
		const textarea = container.createEl("textarea", {
			cls: "rabbitmap-card-textarea",
			attr: { placeholder: "Write something..." },
		});
		textarea.value = node.content;
		textarea.addEventListener("input", () => {
			node.content = textarea.value;
			this.triggerSave();
		});
		// Prevent wheel events from bubbling to canvas
		textarea.addEventListener("wheel", (e) => {
			e.stopPropagation();
		});
	}

	private renderChatContent(nodeId: string, container: HTMLElement): void {
		// Model selector bar
		const selectorBar = container.createDiv({ cls: "rabbitmap-chat-selector-bar" });

		// Click on selector bar selects the node
		selectorBar.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			if (!this.selectedNodes.has(nodeId)) {
				this.clearSelection();
				this.selectNode(nodeId);
			}
		});

		// Get current state or use defaults
		let state = this.chatStates.get(nodeId);
		if (!state) {
			const defaultProvider = this.plugin.settings.providers[0];
			state = {
				provider: defaultProvider.name,
				model: defaultProvider.models[0],
				contextFiles: [],
				systemPrompt: DEFAULT_SYSTEM_PROMPT,
				contextTemplate: DEFAULT_CONTEXT_TEMPLATE
			};
			this.chatStates.set(nodeId, state);
		}
		// Ensure fields exist for old data
		if (!state.contextFiles) {
			state.contextFiles = [];
		}
		if (!state.systemPrompt) {
			state.systemPrompt = DEFAULT_SYSTEM_PROMPT;
		}
		if (!state.contextTemplate) {
			state.contextTemplate = DEFAULT_CONTEXT_TEMPLATE;
		}

		// Provider selector
		const providerSelect = selectorBar.createEl("select", { cls: "rabbitmap-select" });
		for (const provider of this.plugin.settings.providers) {
			const option = providerSelect.createEl("option", {
				text: provider.name,
				value: provider.name
			});
			if (provider.name === state.provider) {
				option.selected = true;
			}
		}

		// Model selector
		const modelSelect = selectorBar.createEl("select", { cls: "rabbitmap-select rabbitmap-model-select" });

		// Edit Prompt button
		const editPromptBtn = selectorBar.createEl("button", {
			text: "Prompt",
			cls: "rabbitmap-btn rabbitmap-edit-prompt-btn"
		});
		editPromptBtn.onclick = (e) => {
			e.stopPropagation();
			const currentState = this.chatStates.get(nodeId);
			new PromptEditorModal(
				this.app,
				currentState?.systemPrompt || "",
				currentState?.contextTemplate || DEFAULT_CONTEXT_TEMPLATE,
				(newPrompt, newTemplate) => {
					const state = this.chatStates.get(nodeId);
					if (state) {
						state.systemPrompt = newPrompt;
						state.contextTemplate = newTemplate;
						this.chatStates.set(nodeId, state);
						this.triggerSave();
					}
				}
			).open();
		};

		const updateModelOptions = () => {
			const currentState = this.chatStates.get(nodeId)!;
			const provider = this.plugin.settings.providers.find(p => p.name === currentState.provider);
			if (!provider) return;

			// Use custom models for OpenRouter if specified
			let models = provider.models;
			if (provider.name === "OpenRouter" && this.plugin.settings.customOpenRouterModels.trim()) {
				models = this.plugin.settings.customOpenRouterModels
					.split("\n")
					.map(m => m.trim())
					.filter(m => m.length > 0);
			}

			modelSelect.empty();
			for (const model of models) {
				const option = modelSelect.createEl("option", {
					text: model,
					value: model
				});
				if (model === currentState.model) {
					option.selected = true;
				}
			}
		};

		updateModelOptions();

		providerSelect.onchange = () => {
			const newProvider = providerSelect.value;
			const provider = this.plugin.settings.providers.find(p => p.name === newProvider);
			if (provider) {
				// Use custom models for OpenRouter if specified
				let models = provider.models;
				if (provider.name === "OpenRouter" && this.plugin.settings.customOpenRouterModels.trim()) {
					models = this.plugin.settings.customOpenRouterModels
						.split("\n")
						.map(m => m.trim())
						.filter(m => m.length > 0);
				}

				const currentState = this.chatStates.get(nodeId);
				const newState: ChatNodeState = {
					provider: newProvider,
					model: models[0],
					contextFiles: currentState?.contextFiles || [],
					systemPrompt: currentState?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
					contextTemplate: currentState?.contextTemplate || DEFAULT_CONTEXT_TEMPLATE
				};
				this.chatStates.set(nodeId, newState);
				updateModelOptions();
				this.triggerSave();
			}
		};

		modelSelect.onchange = () => {
			const currentState = this.chatStates.get(nodeId)!;
			currentState.model = modelSelect.value;
			this.chatStates.set(nodeId, currentState);
			this.triggerSave();
		};

		// Context section
		const contextSection = container.createDiv({ cls: "rabbitmap-chat-context" });
		const contextHeader = contextSection.createDiv({ cls: "rabbitmap-chat-context-header" });
		contextHeader.createSpan({ text: "Context", cls: "rabbitmap-chat-context-title" });

		const contextList = contextSection.createDiv({ cls: "rabbitmap-chat-context-list" });

		const renderContextFiles = () => {
			contextList.empty();
			const currentState = this.chatStates.get(nodeId);

			if (!currentState || currentState.contextFiles.length === 0) {
				// Show placeholder
				const placeholder = contextList.createDiv({ cls: "rabbitmap-chat-context-placeholder" });
				placeholder.setText("Drag your md/folders here");
				return;
			}

			for (const filePath of currentState.contextFiles) {
				const fileItem = contextList.createDiv({ cls: "rabbitmap-chat-context-item" });
				const fileName = filePath.split("/").pop() || filePath;
				fileItem.createSpan({ text: fileName, cls: "rabbitmap-chat-context-filename" });

				const removeBtn = fileItem.createEl("button", { text: "×", cls: "rabbitmap-chat-context-remove" });
				removeBtn.onclick = (e) => {
					e.stopPropagation();
					const state = this.chatStates.get(nodeId);
					if (state) {
						state.contextFiles = state.contextFiles.filter(f => f !== filePath);
						this.chatStates.set(nodeId, state);
						renderContextFiles();
						this.triggerSave();
					}
				};
			}
		};

		renderContextFiles();

		// Drag and drop handling
		container.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.stopPropagation();
			container.addClass("rabbitmap-drag-over");
		});

		container.addEventListener("dragleave", (e) => {
			e.preventDefault();
			container.removeClass("rabbitmap-drag-over");
		});

		container.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			container.removeClass("rabbitmap-drag-over");

			// Get dropped data from Obsidian
			const plainText = e.dataTransfer?.getData("text/plain") || "";

			// Parse path from various formats
			const parsePath = (input: string): string => {
				input = input.trim();

				// Handle obsidian:// URL format
				if (input.startsWith("obsidian://")) {
					try {
						const url = new URL(input);
						const filePath = url.searchParams.get("file");
						if (filePath) {
							return decodeURIComponent(filePath);
						}
					} catch {}
				}

				// Handle URL encoding
				try {
					input = decodeURIComponent(input);
				} catch {}

				// Handle [[wikilink]] format
				const wikiMatch = input.match(/^\[\[(.+?)\]\]$/);
				if (wikiMatch) {
					return wikiMatch[1];
				}

				// Handle [name](path) format
				const mdMatch = input.match(/^\[.+?\]\((.+?)\)$/);
				if (mdMatch) {
					return mdMatch[1];
				}

				// Remove leading slash if present
				if (input.startsWith("/")) {
					input = input.slice(1);
				}

				return input;
			};

			// Add all files from a folder recursively
			const addFilesFromFolder = (folder: TFolder, state: ChatNodeState) => {
				for (const child of folder.children) {
					if (child instanceof TFile) {
						if (!state.contextFiles.includes(child.path)) {
							state.contextFiles.push(child.path);
						}
					} else if (child instanceof TFolder) {
						addFilesFromFolder(child, state);
					}
				}
			};

			// Get all folders recursively
			const getAllFolders = (folder: TFolder): TFolder[] => {
				const folders: TFolder[] = [folder];
				for (const child of folder.children) {
					if (child instanceof TFolder) {
						folders.push(...getAllFolders(child));
					}
				}
				return folders;
			};

			// Try to find file/folder by various methods
			const tryAddPath = (input: string) => {
				if (!input) return false;

				let path = parsePath(input);
				if (!path || path.startsWith("http")) return false;

				// Try to find the file or folder
				let item = this.app.vault.getAbstractFileByPath(path);

				// If not found, try adding .md extension
				if (!item && !path.includes(".")) {
					item = this.app.vault.getAbstractFileByPath(path + ".md");
					if (item) path = path + ".md";
				}

				// If still not found, try to find folder by name
				if (!item && !path.includes(".")) {
					const rootFolder = this.app.vault.getRoot();
					const allFolders = getAllFolders(rootFolder);
					const folderName = path.split("/").pop() || path;
					item = allFolders.find(f =>
						f.path === path ||
						f.name === folderName ||
						f.path.endsWith("/" + path)
					) || null;
				}

				// If still not found, try to find by name in all files
				if (!item) {
					const allFiles = this.app.vault.getFiles();
					const fileName = path.split("/").pop() || path;
					item = allFiles.find(f =>
						f.path === path ||
						f.name === fileName ||
						f.basename === fileName ||
						f.path.endsWith("/" + path)
					) || null;
					if (item) path = item.path;
				}

				const state = this.chatStates.get(nodeId);
				if (!state) return false;

				// Handle folder - add all files from it
				if (item instanceof TFolder) {
					addFilesFromFolder(item, state);
					return true;
				}

				// Handle file
				if (item instanceof TFile) {
					if (!state.contextFiles.includes(path)) {
						state.contextFiles.push(path);
						return true;
					}
				}
				return false;
			};

			let added = false;

			// Try plain text
			if (plainText) {
				// Could be multiple lines
				const lines = plainText.split("\n");
				for (const line of lines) {
					if (tryAddPath(line.trim())) {
						added = true;
					}
				}
			}

			if (added) {
				const state = this.chatStates.get(nodeId);
				if (state) {
					this.chatStates.set(nodeId, state);
					renderContextFiles();
					this.triggerSave();
				}
			}
		});

		const messagesContainer = container.createDiv({ cls: "rabbitmap-chat-messages" });

		// Only prevent wheel events if node is selected
		messagesContainer.addEventListener("wheel", (e) => {
			if (this.selectedNodes.has(nodeId)) {
				e.stopPropagation();
			}
		});

		// Click on messages area selects the node
		messagesContainer.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			if (!this.selectedNodes.has(nodeId)) {
				this.clearSelection();
				this.selectNode(nodeId);
			}
		});

		const messages = this.chatMessages.get(nodeId) || [];
		messages.forEach((msg, index) => {
			this.renderChatMessage(messagesContainer, msg, nodeId, index);
		});

		const inputArea = container.createDiv({ cls: "rabbitmap-chat-input-area" });
		const input = inputArea.createEl("textarea", {
			cls: "rabbitmap-chat-input",
			attr: { placeholder: "Type a message..." },
		});

		// Focus on input selects the node
		input.addEventListener("focus", () => {
			if (!this.selectedNodes.has(nodeId)) {
				this.clearSelection();
				this.selectNode(nodeId);
			}
		});

		const sendBtn = inputArea.createEl("button", {
			text: "Send",
			cls: "rabbitmap-send-btn",
		});

		const sendMessage = async () => {
			const text = input.value.trim();
			if (!text) return;

			// Get chat state to capture current context
			const chatState = this.chatStates.get(nodeId)!;

			const msg: ChatMessage = {
				role: "user",
				content: text,
				contextFiles: chatState.contextFiles ? [...chatState.contextFiles] : []
			};
			const messages = this.chatMessages.get(nodeId) || [];
			messages.push(msg);
			this.chatMessages.set(nodeId, messages);
			this.renderChatMessage(messagesContainer, msg, nodeId, messages.length - 1);
			input.value = "";
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
			this.triggerSave();
			const provider = this.plugin.settings.providers.find(p => p.name === chatState.provider);
			if (!provider) return;

			// Get API key from provider config (with fallback to legacy fields for migration)
			let apiKey = provider.apiKey || "";
			if (!apiKey) {
				// Fallback to legacy API key fields for backward compatibility
				if (chatState.provider === "OpenAI" && this.plugin.settings.openaiApiKey) {
					apiKey = this.plugin.settings.openaiApiKey;
				} else if (chatState.provider === "OpenRouter" && this.plugin.settings.openrouterApiKey) {
					apiKey = this.plugin.settings.openrouterApiKey;
				}
			}

			if (!apiKey) {
				const errorMsg: ChatMessage = {
					role: "assistant",
					content: `Please set your ${chatState.provider} API key in settings.`,
				};
				messages.push(errorMsg);
				this.renderChatMessage(messagesContainer, errorMsg, nodeId, messages.length - 1);
				messagesContainer.scrollTop = messagesContainer.scrollHeight;
				this.triggerSave();
				return;
			}

			// Show loading indicator
			const loadingEl = messagesContainer.createDiv({
				cls: "rabbitmap-chat-message rabbitmap-chat-assistant rabbitmap-chat-loading",
			});
			loadingEl.createSpan({ text: "..." });
			messagesContainer.scrollTop = messagesContainer.scrollHeight;

			// Load context files content
			let contextContent = "";
			if (chatState.contextFiles && chatState.contextFiles.length > 0) {
				const template = chatState.contextTemplate || DEFAULT_CONTEXT_TEMPLATE;
				const contextParts: string[] = [];
				for (const filePath of chatState.contextFiles) {
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file && file instanceof TFile) {
						try {
							const content = await this.app.vault.read(file);
							const formatted = template
								.replace(/\{filepath\}/g, filePath)
								.replace(/\{filename\}/g, file.name)
								.replace(/\{content\}/g, content);
							contextParts.push(formatted);
						} catch {}
					}
				}
				if (contextParts.length > 0) {
					contextContent = "Context files:\n\n" + contextParts.join("\n\n");
				}
			}

			try {
				const response = await this.callLLM(provider, apiKey, chatState.model, messages, contextContent, chatState.systemPrompt || "");
				loadingEl.remove();

				const assistantMsg: ChatMessage = {
					role: "assistant",
					content: response,
				};
				messages.push(assistantMsg);
				this.renderChatMessage(messagesContainer, assistantMsg, nodeId, messages.length - 1);
				messagesContainer.scrollTop = messagesContainer.scrollHeight;
				this.triggerSave();
			} catch (error) {
				loadingEl.remove();
				const errorMsg: ChatMessage = {
					role: "assistant",
					content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
				};
				messages.push(errorMsg);
				this.renderChatMessage(messagesContainer, errorMsg, nodeId, messages.length - 1);
				messagesContainer.scrollTop = messagesContainer.scrollHeight;
				this.triggerSave();
			}
		};

		sendBtn.onclick = sendMessage;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});
	}

	private async callLLM(provider: ProviderConfig, apiKey: string, model: string, messages: ChatMessage[], context: string = "", systemPrompt: string = ""): Promise<string> {
		const apiFormat = provider.apiFormat || "openai";

		switch (apiFormat) {
			case "anthropic":
				return this.callAnthropicAPI(provider, apiKey, model, messages, context, systemPrompt);
			case "google":
				return this.callGoogleAPI(provider, apiKey, model, messages, context, systemPrompt);
			case "openai":
			default:
				return this.callOpenAIAPI(provider, apiKey, model, messages, context, systemPrompt);
		}
	}

	private async callOpenAIAPI(provider: ProviderConfig, apiKey: string, model: string, messages: ChatMessage[], context: string, systemPrompt: string): Promise<string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		};

		// OpenRouter requires additional headers
		if (provider.name === "OpenRouter") {
			headers["HTTP-Referer"] = "https://obsidian.md";
			headers["X-Title"] = "RabbitMap";
		}

		// Build messages array with system prompt and context
		const apiMessages: { role: string; content: string }[] = [];

		// Combine system prompt and context
		const systemParts: string[] = [];
		if (systemPrompt) {
			systemParts.push(systemPrompt);
		}
		if (context) {
			systemParts.push(context);
		}
		if (systemParts.length > 0) {
			apiMessages.push({ role: "system", content: systemParts.join("\n\n") });
		}

		for (const m of messages) {
			apiMessages.push({ role: m.role, content: m.content });
		}

		// Normalize baseUrl - remove trailing slash
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: model,
				messages: apiMessages,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`API error: ${response.status} - ${error}`);
		}

		const data = await response.json();
		return data.choices[0]?.message?.content || "No response";
	}

	private async callAnthropicAPI(provider: ProviderConfig, apiKey: string, model: string, messages: ChatMessage[], context: string, systemPrompt: string): Promise<string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		};

		// Build system prompt
		const systemParts: string[] = [];
		if (systemPrompt) {
			systemParts.push(systemPrompt);
		}
		if (context) {
			systemParts.push(context);
		}

		// Build messages array (Anthropic format)
		const apiMessages: { role: string; content: string }[] = [];
		for (const m of messages) {
			apiMessages.push({ role: m.role, content: m.content });
		}

		const requestBody: Record<string, unknown> = {
			model: model,
			max_tokens: 4096,
			messages: apiMessages,
		};

		if (systemParts.length > 0) {
			requestBody.system = systemParts.join("\n\n");
		}

		// Normalize baseUrl - remove trailing slash and ensure correct path
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const response = await fetch(`${baseUrl}/v1/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Anthropic API error: ${response.status} - ${error}`);
		}

		const data = await response.json();
		// Anthropic returns content as an array of content blocks
		if (data.content && Array.isArray(data.content)) {
			return data.content
				.filter((block: { type: string }) => block.type === "text")
				.map((block: { text: string }) => block.text)
				.join("");
		}
		return "No response";
	}

	private async callGoogleAPI(provider: ProviderConfig, apiKey: string, model: string, messages: ChatMessage[], context: string, systemPrompt: string): Promise<string> {
		// Build system instruction
		const systemParts: string[] = [];
		if (systemPrompt) {
			systemParts.push(systemPrompt);
		}
		if (context) {
			systemParts.push(context);
		}

		// Build contents array (Google Gemini format)
		const contents: { role: string; parts: { text: string }[] }[] = [];
		for (const m of messages) {
			contents.push({
				role: m.role === "assistant" ? "model" : "user",
				parts: [{ text: m.content }]
			});
		}

		const requestBody: Record<string, unknown> = {
			contents: contents,
		};

		if (systemParts.length > 0) {
			requestBody.systemInstruction = {
				parts: [{ text: systemParts.join("\n\n") }]
			};
		}

		// Normalize baseUrl - remove trailing slash
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		// Google uses API key as query parameter
		const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Google API error: ${response.status} - ${error}`);
		}

		const data = await response.json();
		// Google returns candidates array with parts that can be text or inlineData (images)
		if (data.candidates && data.candidates[0]?.content?.parts) {
			const parts = data.candidates[0].content.parts;
			const resultParts: string[] = [];

			for (const part of parts) {
				if (part.text) {
					// Text content
					resultParts.push(part.text);
				} else if (part.inlineData) {
					// Image content - convert to Markdown data URL
					const { mimeType, data: base64Data } = part.inlineData;
					const dataUrl = `data:${mimeType};base64,${base64Data}`;
					resultParts.push(`\n\n![Generated Image](${dataUrl})\n\n`);
				}
			}

			return resultParts.join("") || "No response";
		}
		return "No response";
	}

	private renderChatMessage(container: HTMLElement, msg: ChatMessage, nodeId: string, msgIndex: number): void {
		const msgEl = container.createDiv({
			cls: `rabbitmap-chat-message rabbitmap-chat-${msg.role}`,
		});

		// Render markdown for assistant messages, plain text for user
		if (msg.role === "assistant") {
			const contentEl = msgEl.createDiv({ cls: "rabbitmap-message-content" });
			MarkdownRenderer.render(
				this.app,
				msg.content,
				contentEl,
				"",
				new Component()
			);
		} else {
			msgEl.createSpan({ text: msg.content });
		}

		// Context menu on right click
		msgEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.showMessageContextMenu(nodeId, msgIndex, e);
		});
	}

	private showMessageContextMenu(nodeId: string, msgIndex: number, e: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle("Branch from here")
				.setIcon("git-branch")
				.onClick(() => {
					this.branchChat(nodeId, msgIndex);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Fork")
				.setIcon("git-fork")
				.onClick(() => {
					this.forkChat(nodeId);
				});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle("Save this message")
				.setIcon("file-text")
				.onClick(() => {
					this.exportMessageToMd(nodeId, msgIndex, false);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Save chat up to here")
				.setIcon("files")
				.onClick(() => {
					this.exportMessageToMd(nodeId, msgIndex, true);
				});
		});

		menu.showAtMouseEvent(e);
	}

	private async exportMessageToMd(nodeId: string, msgIndex: number, includeHistory: boolean): Promise<void> {
		const messages = this.chatMessages.get(nodeId) || [];
		const node = this.nodes.get(nodeId);
		const chatState = this.chatStates.get(nodeId);

		if (!node || msgIndex >= messages.length) return;

		const title = node.title || "Chat";
		let md = `# ${title}\n\n`;

		if (chatState) {
			md += `> **Model:** ${chatState.provider} / ${chatState.model}\n\n`;
		}

		md += `---\n\n`;

		if (includeHistory) {
			// Export all messages up to and including msgIndex
			for (let i = 0; i <= msgIndex; i++) {
				const msg = messages[i];
				if (msg.role === "user") {
					md += `## User\n\n`;
					if (msg.contextFiles && msg.contextFiles.length > 0) {
						md += `> **Context:** `;
						md += msg.contextFiles.map(f => `[[${f}]]`).join(", ");
						md += `\n\n`;
					}
					md += `${msg.content}\n\n`;
				} else {
					md += `## Assistant\n\n${msg.content}\n\n`;
				}
			}
		} else {
			// Export only this message
			const msg = messages[msgIndex];
			if (msg.role === "user") {
				md += `## User\n\n`;
				if (msg.contextFiles && msg.contextFiles.length > 0) {
					md += `> **Context:** `;
					md += msg.contextFiles.map(f => `[[${f}]]`).join(", ");
					md += `\n\n`;
				}
				md += `${msg.content}\n\n`;
			} else {
				md += `## Assistant\n\n${msg.content}\n\n`;
			}
		}

		// Get folder path from current file
		const folder = this.file?.parent?.path || "";
		const now = new Date();
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const hours = now.getHours();
		const ampm = hours >= 12 ? "PM" : "AM";
		const hours12 = hours % 12 || 12;
		const timestamp = `${now.getFullYear()} ${months[now.getMonth()]} ${now.getDate()} ${hours12}-${String(now.getMinutes()).padStart(2, "0")} ${ampm}`;
		const suffix = includeHistory ? "" : "-message";
		const fileName = `${title}${suffix} ${timestamp}`.replace(/[\\/:*?"<>|]/g, "-");
		const filePath = folder ? `${folder}/${fileName}.md` : `${fileName}.md`;

		const file = await this.app.vault.create(filePath, md);
		new Notice(`Saved to ${filePath}`);

		// Open the file in a new tab
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
	}

	private updateNodePosition(nodeId: string, x: number, y: number): void {
		const node = this.nodes.get(nodeId);
		const el = this.nodeElements.get(nodeId);
		if (node && el) {
			node.x = x;
			node.y = y;
			el.style.left = `${x}px`;
			el.style.top = `${y}px`;
			this.updateEdges();
		}
	}

	private updateNodeSize(nodeId: string, width: number, height: number): void {
		const node = this.nodes.get(nodeId);
		const el = this.nodeElements.get(nodeId);
		if (node && el) {
			node.width = width;
			node.height = height;
			el.style.width = `${width}px`;
			el.style.height = `${height}px`;
			this.updateMinimap();
			this.updateEdges();
		}
	}

	private deleteNode(nodeId: string): void {
		this.nodes.delete(nodeId);
		this.chatMessages.delete(nodeId);
		this.chatStates.delete(nodeId);
		const el = this.nodeElements.get(nodeId);
		if (el) {
			el.remove();
			this.nodeElements.delete(nodeId);
		}
		// Remove edges connected to this node
		for (const [edgeId, edge] of this.edges) {
			if (edge.from === nodeId || edge.to === nodeId) {
				this.edges.delete(edgeId);
			}
		}
		this.updateEdges();
		this.updateMinimap();
		this.triggerSave();
	}

	private addCardAtCenter(): void {
		const rect = this.canvas.getBoundingClientRect();
		const centerX = (rect.width / 2 - this.panX) / this.scale;
		const centerY = (rect.height / 2 - this.panY) / this.scale;

		this.addNode({
			id: this.generateId(),
			x: centerX - 150,
			y: centerY - 100,
			width: 300,
			height: 200,
			type: "card",
			content: "",
		});
	}

	private addChatAtCenter(): void {
		const rect = this.canvas.getBoundingClientRect();
		const centerX = (rect.width / 2 - this.panX) / this.scale;
		const centerY = (rect.height / 2 - this.panY) / this.scale;

		this.addNode({
			id: this.generateId(),
			x: centerX - 200,
			y: centerY - 250,
			width: 400,
			height: 500,
			type: "chat",
			content: "",
		});
	}

	async onClose(): Promise<void> {
		// Final save before closing
		this.triggerSave();
	}
}

class PromptEditorModal extends Modal {
	private prompt: string;
	private contextTemplate: string;
	private onSave: (prompt: string, template: string) => void;

	constructor(app: any, prompt: string, contextTemplate: string, onSave: (prompt: string, template: string) => void) {
		super(app);
		this.prompt = prompt;
		this.contextTemplate = contextTemplate;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("rabbitmap-prompt-modal");

		// System Prompt section
		contentEl.createEl("h3", { text: "System Prompt" });
		const promptTextarea = contentEl.createEl("textarea", {
			cls: "rabbitmap-prompt-textarea",
			attr: { placeholder: "Enter system prompt for this chat..." }
		});
		promptTextarea.value = this.prompt;

		// Context Template section
		contentEl.createEl("h3", { text: "Context Template", cls: "rabbitmap-prompt-section-title" });
		contentEl.createEl("p", {
			text: "Variables: {filepath}, {filename}, {content}",
			cls: "rabbitmap-prompt-hint"
		});
		const templateTextarea = contentEl.createEl("textarea", {
			cls: "rabbitmap-prompt-textarea rabbitmap-template-textarea",
			attr: { placeholder: "Template for each context file..." }
		});
		templateTextarea.value = this.contextTemplate;

		// Preview
		contentEl.createEl("h4", { text: "Preview", cls: "rabbitmap-prompt-section-title" });
		const preview = contentEl.createDiv({ cls: "rabbitmap-prompt-preview" });

		const updatePreview = () => {
			const template = templateTextarea.value;
			const example = template
				.replace(/\{filepath\}/g, "folder/example.md")
				.replace(/\{filename\}/g, "example.md")
				.replace(/\{content\}/g, "File content here...");
			preview.setText(example);
		};
		updatePreview();
		templateTextarea.addEventListener("input", updatePreview);

		const buttonContainer = contentEl.createDiv({ cls: "rabbitmap-prompt-buttons" });

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => this.close();

		const saveBtn = buttonContainer.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.onclick = () => {
			this.onSave(promptTextarea.value, templateTextarea.value);
			this.close();
		};
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ExpandedChatModal extends Modal {
	private view: RabbitMapView;
	private nodeId: string;
	private messagesContainer: HTMLElement;
	private input: HTMLTextAreaElement;
	private updateInterval: number;

	constructor(app: any, view: RabbitMapView, nodeId: string) {
		super(app);
		this.view = view;
		this.nodeId = nodeId;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		modalEl.addClass("rabbitmap-expanded-chat-modal");
		contentEl.empty();

		const node = this.view.getNode(this.nodeId);
		const chatState = this.view.getChatState(this.nodeId);

		// Header
		const header = contentEl.createDiv({ cls: "rabbitmap-expanded-header" });
		header.createEl("h2", { text: node?.title || "Chat" });

		if (chatState) {
			header.createEl("span", {
				text: `${chatState.provider} / ${chatState.model}`,
				cls: "rabbitmap-expanded-model"
			});
		}

		// Messages
		this.messagesContainer = contentEl.createDiv({ cls: "rabbitmap-expanded-messages" });
		this.renderMessages();

		// Input area
		const inputArea = contentEl.createDiv({ cls: "rabbitmap-expanded-input-area" });
		this.input = inputArea.createEl("textarea", {
			cls: "rabbitmap-expanded-input",
			attr: { placeholder: "Type a message...", rows: "3" }
		});

		const sendBtn = inputArea.createEl("button", {
			text: "Send",
			cls: "rabbitmap-expanded-send-btn"
		});

		sendBtn.onclick = () => this.sendMessage();
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		// Focus input and scroll to bottom
		this.input.focus();
		setTimeout(() => {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}, 50);

		// Sync messages periodically
		this.updateInterval = window.setInterval(() => {
			this.renderMessages();
		}, 500);
	}

	private renderMessages(showLoading: boolean = false) {
		const messages = this.view.getChatMessages(this.nodeId) || [];
		const scrolledToBottom = this.messagesContainer.scrollTop + this.messagesContainer.clientHeight >= this.messagesContainer.scrollHeight - 10;

		this.messagesContainer.empty();

		for (const msg of messages) {
			const msgEl = this.messagesContainer.createDiv({
				cls: `rabbitmap-expanded-message rabbitmap-expanded-${msg.role}`
			});

			if (msg.role === "user" && msg.contextFiles && msg.contextFiles.length > 0) {
				const contextEl = msgEl.createDiv({ cls: "rabbitmap-expanded-context" });
				contextEl.createSpan({ text: "Context: " });
				contextEl.createSpan({ text: msg.contextFiles.map(f => f.split("/").pop()).join(", ") });
			}

			msgEl.createDiv({ cls: "rabbitmap-expanded-content", text: msg.content });
		}

		// Show loading indicator
		if (showLoading) {
			const loadingEl = this.messagesContainer.createDiv({
				cls: "rabbitmap-expanded-message rabbitmap-expanded-assistant rabbitmap-expanded-loading"
			});
			loadingEl.createDiv({ cls: "rabbitmap-expanded-content", text: "..." });
		}

		if (scrolledToBottom || showLoading) {
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}
	}

	private async sendMessage() {
		const text = this.input.value.trim();
		if (!text) return;

		this.input.value = "";
		this.input.disabled = true;

		// Show user message + loading
		this.renderMessages(true);

		await this.view.sendChatMessage(this.nodeId, text);

		this.input.disabled = false;
		this.input.focus();
		this.renderMessages();
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	onClose() {
		if (this.updateInterval) {
			window.clearInterval(this.updateInterval);
		}
		const { contentEl } = this;
		contentEl.empty();
	}
}

class SettingsModal extends Modal {
	plugin: RabbitMapPlugin;

	constructor(app: any, plugin: RabbitMapPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("rabbitmap-settings-modal");

		contentEl.createEl("h2", { text: "Provider Settings" });

		// About section
		const aboutSection = contentEl.createDiv({ cls: "rabbitmap-about-section" });
		aboutSection.createEl("p", {
			text: "This RabbitMap plugin is part of ",
		}).createEl("a", {
			text: "rabbitmap.com",
			href: "https://rabbitmap.com",
		});
		aboutSection.querySelector("p")?.appendText(" — a cloud research OS for saving and organizing web content on canvas.");

		const aboutText = aboutSection.createEl("p");
		aboutText.appendText("We're building deep integration between web research and LLM context — making context management easy and delightful. Built by ");
		aboutText.createEl("a", {
			text: "@bayradion",
			href: "https://x.com/bayradion",
		});
		aboutText.appendText(". Join our ");
		aboutText.createEl("a", {
			text: "Discord community",
			href: "https://discord.gg/UeUBkmxEcV",
		});
		aboutText.appendText("!");

		// Providers section
		const providersContainer = contentEl.createDiv({ cls: "rabbitmap-providers-container" });

		const renderProviders = () => {
			providersContainer.empty();

			for (let i = 0; i < this.plugin.settings.providers.length; i++) {
				const provider = this.plugin.settings.providers[i];
				const providerSection = providersContainer.createDiv({ cls: "rabbitmap-provider-section" });

				// Provider header with name and toggle
				const headerRow = providerSection.createDiv({ cls: "rabbitmap-provider-header" });
				headerRow.createEl("h3", { text: provider.name });

				// Enabled toggle
				const toggleContainer = headerRow.createDiv({ cls: "rabbitmap-provider-toggle" });
				const toggleLabel = toggleContainer.createEl("label", { cls: "rabbitmap-toggle-label" });
				const toggleInput = toggleLabel.createEl("input", { type: "checkbox" });
				toggleInput.checked = provider.enabled;
				toggleLabel.createSpan({ text: provider.enabled ? "Enabled" : "Disabled" });
				toggleInput.onchange = async () => {
					provider.enabled = toggleInput.checked;
					toggleLabel.querySelector("span")!.textContent = provider.enabled ? "Enabled" : "Disabled";
					await this.plugin.saveSettings();
				};

				// Base URL setting
				new Setting(providerSection)
					.setName("Base URL")
					.setDesc("API endpoint URL (change for custom/proxy deployments)")
					.addText((text) =>
						text
							.setPlaceholder("https://api.example.com/v1")
							.setValue(provider.baseUrl)
							.onChange(async (value) => {
								provider.baseUrl = value;
								await this.plugin.saveSettings();
							})
					);

				// API Key setting
				new Setting(providerSection)
					.setName("API Key")
					.setDesc(`Enter your ${provider.name} API key`)
					.addText((text) =>
						text
							.setPlaceholder("sk-...")
							.setValue(provider.apiKey)
							.onChange(async (value) => {
								provider.apiKey = value;
								await this.plugin.saveSettings();
							})
					);

				// API Format setting
				new Setting(providerSection)
					.setName("API Format")
					.setDesc("Select the API format for this provider")
					.addDropdown((dropdown) =>
						dropdown
							.addOption("openai", "OpenAI Compatible")
							.addOption("anthropic", "Anthropic (Claude)")
							.addOption("google", "Google (Gemini)")
							.setValue(provider.apiFormat || "openai")
							.onChange(async (value) => {
								provider.apiFormat = value as "openai" | "anthropic" | "google";
								await this.plugin.saveSettings();
							})
					);

				// Models section
				const modelsHeader = providerSection.createDiv({ cls: "rabbitmap-models-header" });
				modelsHeader.createEl("h4", { text: "Models" });

				// Models input row
				const inputRow = providerSection.createDiv({ cls: "rabbitmap-models-input-row" });
				const modelInput = inputRow.createEl("input", {
					type: "text",
					placeholder: "e.g. gpt-4o or anthropic/claude-3.5-sonnet",
					cls: "rabbitmap-models-input"
				});
				const addButton = inputRow.createEl("button", {
					text: "Add",
					cls: "rabbitmap-models-add-btn"
				});

				// Models list
				const modelsList = providerSection.createDiv({ cls: "rabbitmap-models-list" });

				const renderModelsList = () => {
					modelsList.empty();
					if (provider.models.length === 0) {
						modelsList.createEl("div", {
							text: "No models configured.",
							cls: "rabbitmap-models-empty"
						});
						return;
					}

					for (const model of provider.models) {
						const item = modelsList.createDiv({ cls: "rabbitmap-models-item" });
						item.createSpan({ text: model, cls: "rabbitmap-models-name" });
						const removeBtn = item.createEl("button", {
							text: "×",
							cls: "rabbitmap-models-remove-btn"
						});
						removeBtn.onclick = async () => {
							provider.models = provider.models.filter(m => m !== model);
							await this.plugin.saveSettings();
							renderModelsList();
						};
					}
				};

				addButton.onclick = async () => {
					const newModel = modelInput.value.trim();
					if (!newModel) return;
					if (!provider.models.includes(newModel)) {
						provider.models.push(newModel);
						await this.plugin.saveSettings();
					}
					modelInput.value = "";
					renderModelsList();
				};

				modelInput.onkeydown = (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						addButton.click();
					}
				};

				renderModelsList();
			}

			// Add new provider button
			const addProviderRow = providersContainer.createDiv({ cls: "rabbitmap-add-provider-row" });
			const newProviderInput = addProviderRow.createEl("input", {
				type: "text",
				placeholder: "New provider name (e.g. Ollama)",
				cls: "rabbitmap-new-provider-input"
			});
			const addProviderBtn = addProviderRow.createEl("button", {
				text: "Add Provider",
				cls: "rabbitmap-add-provider-btn"
			});

			addProviderBtn.onclick = async () => {
				const name = newProviderInput.value.trim();
				if (!name) return;
				if (this.plugin.settings.providers.some(p => p.name === name)) {
					new Notice(`Provider "${name}" already exists.`);
					return;
				}
				this.plugin.settings.providers.push({
					name,
					baseUrl: "https://api.example.com/v1",
					apiKey: "",
					models: [],
					enabled: true
				});
				await this.plugin.saveSettings();
				newProviderInput.value = "";
				renderProviders();
			};
		};

		renderProviders();

		// Help links
		contentEl.createEl("p", {
			text: "Get your API keys from:",
			cls: "rabbitmap-settings-info",
		});

		const linkContainer = contentEl.createDiv({ cls: "rabbitmap-settings-links" });
		linkContainer.createEl("a", {
			text: "OpenAI Platform",
			href: "https://platform.openai.com/api-keys",
		});
		linkContainer.createEl("span", { text: " | " });
		linkContainer.createEl("a", {
			text: "OpenRouter",
			href: "https://openrouter.ai/keys",
		});
		linkContainer.createEl("span", { text: " | " });
		linkContainer.createEl("a", {
			text: "Google AI Studio",
			href: "https://aistudio.google.com/apikey",
		});
		linkContainer.createEl("span", { text: " | " });
		linkContainer.createEl("a", {
			text: "Anthropic Console",
			href: "https://console.anthropic.com/settings/keys",
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export default class RabbitMapPlugin extends Plugin {
	settings: PluginSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Register the view
		this.registerView(VIEW_TYPE_RABBITMAP, (leaf) => new RabbitMapView(leaf, this));

		// Register file extension
		this.registerExtensions([FILE_EXTENSION], VIEW_TYPE_RABBITMAP);

		// Add ribbon icon
		this.addRibbonIcon("layout-dashboard", "Create new RabbitMap", async () => {
			await this.createNewCanvas();
		});

		// Add command to create new canvas
		this.addCommand({
			id: "create-new-rabbitmap",
			name: "Create new RabbitMap canvas",
			callback: async () => {
				await this.createNewCanvas();
			},
		});

		// Add context menu for folders
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) => {
						item.setTitle("New RabbitMap")
							.setIcon("layout-dashboard")
							.onClick(async () => {
								await this.createNewCanvas(file.path);
							});
					});
				}
			})
		);
	}

	async createNewCanvas(folderPath?: string): Promise<void> {
		const folder = folderPath || "";
		let fileName = "Untitled";
		let counter = 1;
		let filePath = folder ? `${folder}/${fileName}.${FILE_EXTENSION}` : `${fileName}.${FILE_EXTENSION}`;

		// Find unique name
		while (this.app.vault.getAbstractFileByPath(filePath)) {
			fileName = `Untitled ${counter}`;
			filePath = folder ? `${folder}/${fileName}.${FILE_EXTENSION}` : `${fileName}.${FILE_EXTENSION}`;
			counter++;
		}

		// Create file with empty data structure
		const initialData: RabbitMapData = {
			nodes: [],
			edges: [],
			chatMessages: {},
			chatStates: {},
			view: { scale: 1, panX: 0, panY: 0 }
		};
		const file = await this.app.vault.create(filePath, JSON.stringify(initialData, null, 2));

		// Open it
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);

		new Notice(`Created ${fileName}.${FILE_EXTENSION}`);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	onunload(): void {}
}
