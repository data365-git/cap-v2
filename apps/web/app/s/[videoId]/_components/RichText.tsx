"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface RichTextProps {
	children?: string | null;
	inline?: boolean;
	className?: string;
}

export function RichText({ children, inline = false, className }: RichTextProps) {
	if (!children) return null;

	const strongStyle: React.CSSProperties = { fontWeight: 650 };

	if (inline) {
		return (
			<span className={className}>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={{
						p: ({ children: c }) => <span>{c}</span>,
						h1: ({ children: c }) => <span>{c}</span>,
						h2: ({ children: c }) => <span>{c}</span>,
						h3: ({ children: c }) => <span>{c}</span>,
						h4: ({ children: c }) => <span>{c}</span>,
						h5: ({ children: c }) => <span>{c}</span>,
						h6: ({ children: c }) => <span>{c}</span>,
						ul: ({ children: c }) => <span>{c}</span>,
						ol: ({ children: c }) => <span>{c}</span>,
						li: ({ children: c }) => <span>{c} </span>,
						strong: ({ children: c }) => <strong style={strongStyle}>{c}</strong>,
						em: ({ children: c }) => <em>{c}</em>,
					}}
				>
					{children}
				</ReactMarkdown>
			</span>
		);
	}

	return (
		<span className={className}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					h1: ({ children: c }) => <strong style={strongStyle}>{c}</strong>,
					strong: ({ children: c }) => <strong style={strongStyle}>{c}</strong>,
					em: ({ children: c }) => <em>{c}</em>,
					ul: ({ children: c }) => (
						<ul style={{ paddingLeft: "1.25rem", margin: "0.25rem 0" }}>{c}</ul>
					),
					ol: ({ children: c }) => (
						<ol style={{ paddingLeft: "1.25rem", margin: "0.25rem 0" }}>{c}</ol>
					),
					li: ({ children: c }) => (
						<li style={{ marginBottom: "0.125rem" }}>{c}</li>
					),
				}}
			>
				{children}
			</ReactMarkdown>
		</span>
	);
}
