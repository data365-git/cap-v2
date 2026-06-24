"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check, Square, RefreshCw } from "lucide-react";
import {
	LiquidGlassContainer,
	type LiquidGlassHandle,
} from "./LiquidGlassContainer";
import "./ai-chat.css";

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	stopped?: boolean;
	error?: boolean;
}

let msgIdCounter = 0;
function nextMsgId() {
	return `msg-${++msgIdCounter}`;
}

interface AIChatPopupProps {
	videoId: string;
	onVideoJump: (seconds: number) => void;
	onClose: () => void;
	isOpen?: boolean;
}

const QUICK_ACTIONS = [
	{
		label: "Qisqacha xulosa",
		query: "Uchrashuvni qisqacha xulosalab bering",
	},
	{
		label: "Vazifalar ro'yxati",
		query: "Asosiy vazifalar va mas'ullar kimlar?",
	},
	{
		label: "Follow-up xat",
		query: "Keyingi qadamlar bo'yicha follow-up xat tayyorlab bering",
	},
	{
		label: "Asosiy qarorlar",
		query: "Qanaqa asosiy qarorlar qabul qilindi?",
	},
];

function parseMmSsToSeconds(mmss: string): number {
	const parts = mmss.split(":");
	if (parts.length === 3) {
		return (
			parseInt(parts[0] ?? "0", 10) * 3600 +
			parseInt(parts[1] ?? "0", 10) * 60 +
			parseInt(parts[2] ?? "0", 10)
		);
	}
	if (parts.length === 2) {
		return parseInt(parts[0] ?? "0", 10) * 60 + parseInt(parts[1] ?? "0", 10);
	}
	return 0;
}

// Pre-process markdown text to turn [MM:SS] / [HH:MM:SS] into a custom token
// that ReactMarkdown can detect in a text node, since react-markdown doesn't
// provide a low-level "text" component override in v9+.
// We wrap timestamps with a special delimiter that we then split on.
const TIMESTAMP_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function splitTimestamps(
	text: string,
	onVideoJump: (s: number) => void,
): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	TIMESTAMP_RE.lastIndex = 0;
	while ((m = TIMESTAMP_RE.exec(text)) !== null) {
		if (m.index > last) parts.push(text.slice(last, m.index));
		const ts = m[1] ?? "";
		const secs = parseMmSsToSeconds(ts);
		parts.push(
			<button
				key={`ts-${m.index}`}
				type="button"
				className="ai-citation"
				onClick={() => onVideoJump(secs)}
				aria-label={`Jump to ${ts}`}
			>
				{m[0]}
			</button>,
		);
		last = m.index + m[0].length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}

// Custom ReactMarkdown text renderer that intercepts timestamp patterns.
// We use the `components` prop's `text` override only available in some versions;
// instead we render timestamps inside the `p` / `li` etc overrides by walking children.
// Simplest robust approach: wrap text children through a helper.
function processChildren(
	children: React.ReactNode,
	onVideoJump: (s: number) => void,
): React.ReactNode {
	if (typeof children === "string") {
		const parts = splitTimestamps(children, onVideoJump);
		if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
		return <>{parts}</>;
	}
	if (Array.isArray(children)) {
		return children.map((child, i) => {
			if (typeof child === "string") {
				const parts = splitTimestamps(child, onVideoJump);
				if (parts.length === 1 && typeof parts[0] === "string") return parts[0];
				return <span key={i}>{parts}</span>;
			}
			return child;
		});
	}
	return children;
}

function MarkdownContent({
	text,
	onVideoJump,
}: {
	text: string;
	onVideoJump: (s: number) => void;
}) {
	return (
		<div className="prose-chat">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					p: ({ children }) => (
						<p>{processChildren(children, onVideoJump)}</p>
					),
					li: ({ children }) => (
						<li>{processChildren(children, onVideoJump)}</li>
					),
					ul: ({ children }) => <ul>{children}</ul>,
					ol: ({ children }) => <ol>{children}</ol>,
					strong: ({ children }) => <strong>{children}</strong>,
					em: ({ children }) => <em>{children}</em>,
					code: ({ children, className }) => {
						const isBlock = className?.includes("language-");
						return isBlock ? (
							<code style={{ display: "block", overflowX: "auto" }}>
								{children}
							</code>
						) : (
							<code>{children}</code>
						);
					},
					pre: ({ children }) => <pre>{children}</pre>,
					a: ({ href, children }) => (
						<a
							href={href}
							target={href?.startsWith("/") ? "_self" : "_blank"}
							rel={href?.startsWith("/") ? undefined : "noreferrer"}
						>
							{children}
						</a>
					),
					blockquote: ({ children }) => <blockquote>{children}</blockquote>,
					hr: () => <hr />,
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable — silent fail
		}
	};

	return (
		<button
			type="button"
			className="ai-msg-action"
			onClick={handleCopy}
			aria-label={copied ? "Copied" : "Copy message"}
			title={copied ? "Copied!" : "Copy"}
		>
			{copied ? <Check size={13} /> : <Copy size={13} />}
		</button>
	);
}

function OrbIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path
				d="M12 7.5 13.4 11.2 17 12l-3.6 1L12 16.5 10.6 13 7 12l3.6-.8z"
				fill="currentColor"
				stroke="none"
			/>
			<circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
		</svg>
	);
}

function ChipSummaryIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M4 6h16M4 11h16M4 16h10" />
		</svg>
	);
}

function ChipTasksIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m3 7 1.6 1.6L8 5" />
			<path d="m3 17 1.6 1.6L8 15" />
			<path d="M11 7h10M11 17h10" />
		</svg>
	);
}

function ChipEmailIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="3" y="5" width="18" height="14" rx="2.5" />
			<path d="m3.5 7 8.5 6 8.5-6" />
		</svg>
	);
}

function ChipDecisionsIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M12 2.6l2.5 1.85 3.1.05.05 3.1L19.4 10l-1.85 2.5.05 3.1-3.1.05L12 17.4l-2.5-1.85-3.1-.05-.05-3.1L4.6 10l1.85-2.5-.05-3.1 3.1-.05z" />
			<path d="m9.2 10.2 2 2 3.6-3.6" />
		</svg>
	);
}

const CHIP_ICONS = [
	<ChipSummaryIcon key="summary" />,
	<ChipTasksIcon key="tasks" />,
	<ChipEmailIcon key="email" />,
	<ChipDecisionsIcon key="decisions" />,
];

export function AIChatPopup({
	videoId,
	onVideoJump,
	onClose,
	isOpen = false,
}: AIChatPopupProps) {
	const [messages, setMessages] = useState<Message[]>([]);
	// Always-current snapshot of messages so callbacks can read the latest array
	// synchronously (regenerate updates state + ref together to avoid a stale-
	// closure race when it immediately re-calls sendMessage).
	const messagesRef = useRef<Message[]>([]);
	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const [lastUserPrompt, setLastUserPrompt] = useState<string>("");
	const bodyRef = useRef<HTMLDivElement>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const glassHostRef = useRef<HTMLDivElement>(null);
	const glassRef = useRef<LiquidGlassHandle>(null);
	const abortRef = useRef<AbortController | null>(null);

	const resizeState = useRef<{
		startX: number;
		startY: number;
		startW: number;
		startH: number;
	} | null>(null);

	// Stop in-flight stream when popup closes
	useEffect(() => {
		if (!isOpen && isStreaming) {
			abortRef.current?.abort();
		}
	}, [isOpen, isStreaming]);

	// Focus textarea when popup opens
	useEffect(() => {
		if (isOpen) {
			// Small delay so the CSS transition has started and the element is interactive
			const t = setTimeout(() => textareaRef.current?.focus(), 50);
			return () => clearTimeout(t);
		}
	}, [isOpen]);

	useEffect(() => {
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [onClose]);

	// Streaming-aware auto-scroll: "auto" while streaming (fast, no jank), "smooth" otherwise
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional scroll trigger
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 60;
		if (isNearBottom) {
			el.scrollTo({ top: el.scrollHeight, behavior: isStreaming ? "auto" : "smooth" });
		}
	}, [messages, isStreaming]);

	const adjustTextarea = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 90)}px`;
	};

	const stopStreaming = useCallback(() => {
		abortRef.current?.abort();
		abortRef.current = null;
		setIsStreaming(false);
		// Mark the last assistant message as stopped
		setMessages((prev) => {
			const updated = [...prev];
			const last = updated[updated.length - 1];
			if (last?.role === "assistant") {
				updated[updated.length - 1] = { ...last, stopped: true };
			}
			messagesRef.current = updated;
			return updated;
		});
	}, []);

	const sendMessage = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || isStreaming) return;

			setLastUserPrompt(trimmed);

			const userMsg: Message = {
				id: nextMsgId(),
				role: "user",
				content: trimmed,
			};
			// Read from the ref, not the closure — regenerate may have just popped
			// the failed assistant entry and we need the freshest array.
			const nextMessages = [...messagesRef.current, userMsg];
			messagesRef.current = nextMessages;
			setMessages(nextMessages);
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
			setIsStreaming(true);

			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			let assistantContent = "";
			const assistantId = nextMsgId();

			try {
				const response = await fetch("/api/video/ai/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoId,
						messages: nextMessages.map((m) => ({
							role: m.role,
							content: m.content,
						})),
					}),
					signal: controller.signal,
				});

				if (!response.ok || !response.body) {
					throw new Error(`Request failed: ${response.status}`);
				}

				setMessages((prev) => {
					const next = [
						...prev,
						{ id: assistantId, role: "assistant" as const, content: "" },
					];
					messagesRef.current = next;
					return next;
				});

				const reader = response.body.getReader();
				const decoder = new TextDecoder();

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value, { stream: true });
					const lines = chunk.split("\n");

					for (const line of lines) {
						const trimmedLine = line.trim();
						if (!trimmedLine.startsWith("data:")) continue;
						const payload = trimmedLine.slice(5).trim();
						if (payload === "[DONE]") break;

						try {
							const parsed = JSON.parse(payload) as { token?: string };
							if (parsed.token) {
								assistantContent += parsed.token;
								setMessages((prev) => {
									const updated = [...prev];
									const last = updated[updated.length - 1];
									if (last?.role === "assistant" && last.id === assistantId) {
										updated[updated.length - 1] = {
											...last,
											content: assistantContent,
										};
									}
									messagesRef.current = updated;
									return updated;
								});
							}
						} catch {
							// non-JSON SSE lines skipped
						}
					}
				}
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					// Handled by stopStreaming — leave partial message in place
					return;
				}
				// Real error: mark the assistant message (or add one) with error flag
				setMessages((prev) => {
					const updated = [...prev];
					const last = updated[updated.length - 1];
					if (last?.role === "assistant" && last.id === assistantId) {
						updated[updated.length - 1] = {
							...last,
							content: last.content || "Something went wrong. Please try again.",
							error: true,
						};
						messagesRef.current = updated;
						return updated;
					}
					const next: Message[] = [
						...prev,
						{
							id: nextMsgId(),
							role: "assistant",
							content: "Something went wrong. Please try again.",
							error: true,
						},
					];
					messagesRef.current = next;
					return next;
				});
			} finally {
				setIsStreaming(false);
				abortRef.current = null;
			}
		},
		[videoId, messages, isStreaming],
	);

	const regenerate = useCallback(() => {
		if (!lastUserPrompt || isStreaming) return;
		// Pop the last assistant entry and sync the ref synchronously, so the
		// immediately-following sendMessage reads the trimmed array (not the
		// stale closure that still contains the popped message).
		const current = messagesRef.current;
		const trimmed =
			current[current.length - 1]?.role === "assistant"
				? current.slice(0, -1)
				: current;
		messagesRef.current = trimmed;
		setMessages(trimmed);
		// Safe to call now — sendMessage reads messagesRef.current, not closure.
		sendMessage(lastUserPrompt);
	}, [lastUserPrompt, isStreaming, sendMessage]);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage(input);
		}
	};

	const onResizeMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
		const el = popupRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		resizeState.current = {
			startX: e.clientX,
			startY: e.clientY,
			startW: rect.width,
			startH: rect.height,
		};

		const onMove = (ev: MouseEvent) => {
			if (!resizeState.current || !popupRef.current) return;
			const dx = resizeState.current.startX - ev.clientX;
			const dy = resizeState.current.startY - ev.clientY;
			const newW = Math.max(300, resizeState.current.startW + dx);
			const newH = Math.max(360, resizeState.current.startH + dy);
			popupRef.current.style.width = `${newW}px`;
			popupRef.current.style.height = `${newH}px`;
		};

		const onUp = () => {
			resizeState.current = null;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const hasMessages = messages.length > 0;

	return (
		<div
			ref={popupRef}
			className={`ai-popup${isOpen ? " open" : ""}`}
			role="dialog"
			aria-label="AI assistant"
			aria-hidden={!isOpen}
			aria-modal={isOpen || undefined}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: inert removes focus from closed popup
			{...(!isOpen ? { inert: "" } : {})}
		>
			<div ref={glassHostRef} className="ai-glass-host" />
			<LiquidGlassContainer ref={glassRef} hostRef={glassHostRef} />
			<div className="ai-tint-overlay" />
			<div className="ai-noise" />
			{/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle is mouse-only by design */}
			<div className="ai-resize" onMouseDown={onResizeMouseDown} />

			<div className="ai-hd">
				<div className="orb-sm">
					<OrbIcon />
				</div>
				<div className="htxt">
					<div className="t">Meeting AI</div>
					<div className="s">
						<span className="live" />
						Ushbu uchrashuv konteksti yuklandi
					</div>
				</div>
				<button
					type="button"
					className="ai-x"
					onClick={onClose}
					aria-label="Close AI chat"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						aria-hidden="true"
					>
						<path d="M18 6 6 18M6 6l12 12" />
					</svg>
				</button>
			</div>

			<div ref={bodyRef} className="ai-body" aria-live="polite" aria-atomic="false" aria-relevant="additions">
				{!hasMessages && (
					<>
						<div className="ai-welcome">
							<div className="wt">
								Salom! Men bu uchrashuv haqida{" "}
								<span className="grad">hamma narsani</span> bilaman.
							</div>
							<div className="ws">
								Transkript, vazifalar va qarorlar bo&apos;yicha savol bering —
								yoki quyidagilardan birini tanlang.
							</div>
						</div>
						<div className="ai-chips">
							{QUICK_ACTIONS.map((action, idx) => (
								<button
									key={action.query}
									type="button"
									className="ai-chip"
									onClick={() => sendMessage(action.query)}
								>
									{CHIP_ICONS[idx]}
									{action.label}
								</button>
							))}
						</div>
					</>
				)}

				{messages.map((msg) => (
					<div
						key={msg.id}
						className={`ai-msg${msg.role === "user" ? " user" : " ai"}`}
					>
						{msg.role === "assistant" && (
							<div className="av">
								<OrbIcon />
							</div>
						)}
						<div className="bubble-wrap">
							<div className="bubble">
								{msg.role === "assistant" ? (
									msg.content === "" && isStreaming && msg.id === messages[messages.length - 1]?.id ? (
										<div className="ai-typing">
											<span />
											<span />
											<span />
										</div>
									) : (
										<MarkdownContent
											text={msg.content}
											onVideoJump={onVideoJump}
										/>
									)
								) : (
									msg.content
								)}
							</div>
							{msg.stopped && (
								<span className="ai-stopped-badge">stopped</span>
							)}
							{msg.error && (
								<div className="ai-error-row">
									<span className="ai-error-label">⚠ Error</span>
									<button
										type="button"
										className="ai-regenerate"
										onClick={regenerate}
										aria-label="Regenerate response"
									>
										<RefreshCw size={13} />
										Retry
									</button>
								</div>
							)}
							{msg.role === "assistant" && !msg.error && (
								<div className="ai-msg-actions">
									<CopyButton text={msg.content} />
								</div>
							)}
						</div>
					</div>
				))}

				{isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
					<div className="ai-msg ai">
						<div className="av">
							<OrbIcon />
						</div>
						<div className="bubble-wrap">
							<div className="ai-typing">
								<span />
								<span />
								<span />
							</div>
						</div>
					</div>
				)}

				<div ref={messagesEndRef} />
			</div>

			<div className="ai-foot">
				<div className="ai-inputbar">
					<textarea
						ref={textareaRef}
						rows={1}
						placeholder="Uchrashuv haqida so'rang..."
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							adjustTextarea();
						}}
						onKeyDown={handleKeyDown}
						disabled={isStreaming}
						aria-label="Message input"
					/>
					{isStreaming ? (
						<button
							type="button"
							className="ai-send ai-stop"
							onClick={stopStreaming}
							aria-label="Stop generating"
						>
							<Square size={14} fill="currentColor" />
						</button>
					) : (
						<button
							type="button"
							className="ai-send"
							onClick={() => sendMessage(input)}
							disabled={!input.trim() || isStreaming}
							aria-label="Send message"
						>
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.4"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<path d="M12 20V5" />
								<path d="m6 11 6-6 6 6" />
							</svg>
						</button>
					)}
				</div>
				<div className="ai-disclaimer">
					AI javoblari tekshirilishi kerak bo&apos;lishi mumkin
				</div>
			</div>
		</div>
	);
}
