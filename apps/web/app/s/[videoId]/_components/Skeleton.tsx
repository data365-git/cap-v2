"use client";
import type { ReactNode } from "react";

export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`cap-skel ${className}`} style={style} aria-hidden="true" />;
}

export function SkeletonGroup({ children }: { children: ReactNode }) {
  return <div className="cap-skel-group">{children}</div>;
}
