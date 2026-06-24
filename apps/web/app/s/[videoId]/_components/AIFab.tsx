"use client";

import "./ai-chat.css";

interface AIFabProps {
	onClick: () => void;
	isOpen?: boolean;
}

export function AIFab({ onClick, isOpen }: AIFabProps) {
	return (
		<button
			type="button"
			className={`ai-fab${isOpen ? " is-open" : ""}`}
			onClick={onClick}
			aria-label={isOpen ? "Close AI assistant" : "Ask AI about this meeting"}
		>
			{isOpen ? (
				<svg
					className="orb"
					viewBox="0 0 24 24"
					fill="none"
					stroke="white"
					strokeWidth="2.2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			) : (
				<svg
					className="orb"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path
						d="M12 4 L13.3 10.7 L20 12 L13.3 13.3 L12 20 L10.7 13.3 L4 12 L10.7 10.7 Z"
						fill="currentColor"
						stroke="none"
					/>
				</svg>
			)}
		</button>
	);
}
