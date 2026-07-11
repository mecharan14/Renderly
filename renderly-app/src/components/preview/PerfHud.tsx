import { useEditorStore } from "../../store/editorStore";

/// Tiny frame-time overlay for the preview panel — improvement-plan A0, "measure from day
/// one" before A1 (texture pooling), A2 (preview-res decode), A3 (hwaccel) etc. touch this
/// hot path. Toggle with Ctrl/Cmd+Shift+P (see `App.tsx`). Purely a readout: it renders
/// whatever the backend's playback loop already measured and emitted on `playback:perf`
/// (~1Hz averages) — no client-side timing of its own.
export function PerfHud() {
  const visible = useEditorStore((s) => s.perfHudVisible);
  const sample = useEditorStore((s) => s.perfSample);
  if (!visible) return null;

  const row = (label: string, ms: number | undefined) => (
    <div className="perf-hud-row">
      <span>{label}</span>
      <span>{ms == null ? "—" : `${ms.toFixed(1)} ms`}</span>
    </div>
  );

  return (
    <div className="perf-hud" aria-live="off">
      <div className="perf-hud-title">Perf (Ctrl+Shift+P)</div>
      {sample ? (
        <>
          {row("decode", sample.decode_ms)}
          {row("compose", sample.compose_ms)}
          {row("present", sample.present_ms)}
          {row("frame", sample.frame_ms)}
          <div className="perf-hud-row">
            <span>fps</span>
            <span>{sample.fps.toFixed(1)}</span>
          </div>
        </>
      ) : (
        <div className="perf-hud-row">
          <span>waiting for playback…</span>
        </div>
      )}
    </div>
  );
}
