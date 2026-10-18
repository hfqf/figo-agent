import { useEffect, useRef, useState } from "react";
import type { GuideId, OnboardingSnapshot } from "../../src/config/onboarding-settings.js";
import { request } from "./api";
import { onboardingCopy } from "./i18n";
import workbenchImage from "../../assets/onboarding-desktop-v1.png";
import inspectorImage from "../../assets/onboarding-trace-inspector-v1.png";
import "./onboarding.css";

export interface GuideReplay { guide: GuideId; serial: number }
const images: Record<GuideId, { src: string; title: string; alt: string }> = {
  workbench: { src: workbenchImage, title: onboardingCopy.workbench, alt: onboardingCopy.workbenchAlt },
  "trace-inspector": { src: inspectorImage, title: onboardingCopy.traceInspector, alt: onboardingCopy.traceInspectorAlt }
};

export function Onboarding({ snapshot, csrf, view, replay, onError }: {
  snapshot?: OnboardingSnapshot;
  csrf: string;
  view: GuideId | null;
  replay?: GuideReplay | null;
  onError(message: string): void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [closedReplay, setClosedReplay] = useState<number | null>(null);
  const saving = useRef(new Set<string>());
  const forced = replay && replay.serial !== closedReplay ? replay : null;
  const guide = forced?.guide ?? (view && snapshot?.enabled && !snapshot.seen.includes(view) &&
    !dismissed.has(`${snapshot.revision}:${view}`) ? view : null);
  if (!guide || !snapshot) return null;
  const revision = snapshot.revision;
  const key = `${revision}:${guide}`;

  function dismiss(displayed: boolean) {
    setDismissed((current) => new Set([...current, key]));
    if (forced) setClosedReplay(forced.serial);
    if (!displayed || saving.current.has(key)) return;
    saving.current.add(key);
    void request("/api/v1/settings/onboarding", { method: "PUT", csrf, body: { guide, revision } })
      .catch(() => onError(onboardingCopy.saveFailed))
      .finally(() => saving.current.delete(key));
  }

  return <GuidePicture key={key} guide={guide} onDismiss={dismiss} />;
}

function GuidePicture({ guide, onDismiss }: { guide: GuideId; onDismiss(displayed: boolean): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const imageElement = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  const image = images[guide];
  const dismiss = () => onDismiss(!failed && Boolean(imageElement.current?.complete && imageElement.current.naturalWidth > 0));
  useEffect(() => {
    const element = dialog.current!;
    element.showModal(); button.current?.focus({ preventScroll: true });
    return () => { element.close(); };
  }, []);

  return <dialog ref={dialog} className="onboarding-overlay" aria-label={image.title}
    onClick={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); dismiss(); }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Tab") { event.preventDefault(); button.current?.focus({ preventScroll: true }); }
      if (["Escape", "Enter", " "].includes(event.key)) { event.preventDefault(); dismiss(); }
    }}>
    <button ref={button} type="button" className="onboarding-picture" aria-label={onboardingCopy.dismiss}>
      {failed ? <p role="alert">{onboardingCopy.loadFailed}</p> :
        <img ref={imageElement} src={image.src} alt={image.alt} draggable={false} onError={() => setFailed(true)} />}
    </button>
  </dialog>;
}
