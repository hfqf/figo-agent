import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { copy, formatCopy } from "./i18n";
import type { WorkspaceBoundary } from "./workspace-layout";

interface Props {
  boundary: WorkspaceBoundary;
  label: string;
  value: number;
  min: number;
  max: number;
  onDelta(boundary: WorkspaceBoundary, delta: number): void;
  onReset(boundary: WorkspaceBoundary): void;
}

export function ResizeHandle({ boundary, label, value, min, max, onDelta, onReset }: Props) {
  const lastX = useRef<number | null>(null);

  function stop() {
    lastX.current = null;
    document.body.classList.remove("workspace-resizing");
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    lastX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-resizing");
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (lastX.current === null) return;
    const delta = event.clientX - lastX.current;
    lastX.current = event.clientX;
    if (delta) onDelta(boundary, delta);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onDelta(boundary, (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 48 : 16));
  }

  return <div
    className={`resize-handle resize-${boundary}`}
    role="separator" aria-orientation="vertical" aria-label={label}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    tabIndex={0} title={formatCopy(copy.resizeHandleHint, { label })}
    onPointerDown={start} onPointerMove={move}
    onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); stop(); }}
    onPointerCancel={stop} onLostPointerCapture={stop}
    onKeyDown={keyDown} onDoubleClick={() => onReset(boundary)}
  />;
}
