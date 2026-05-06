import type { ReactNode } from "react";
import React from "react";

export class ErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null; errorInfo: string | null }
> {
  state = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error) {
    return { error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo: errorInfo.componentStack || null });
    // Keep it simple: console is the source of truth in dev.
    // eslint-disable-next-line no-console
    console.error("UI crashed:", error, errorInfo);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div style={{ padding: 24, fontFamily: "Inter, system-ui, sans-serif" }}>
        <div style={{ fontFamily: "Playfair Display, serif", fontSize: 28 }}>
          Something broke in the UI
        </div>
        <div style={{ marginTop: 12, opacity: 0.75 }}>{this.state.error.message}</div>
        {this.state.errorInfo && (
          <pre style={{ marginTop: 16, whiteSpace: "pre-wrap", opacity: 0.75 }}>
            {this.state.errorInfo}
          </pre>
        )}
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              border: "1px solid rgba(26,26,26,0.35)",
              padding: "10px 14px",
              background: "transparent",
              cursor: "pointer",
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              fontSize: 10
            }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

