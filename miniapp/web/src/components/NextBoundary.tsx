/**
 * If one view throws, only that view is replaced, never the whole app.
 * It retries once by itself (most render errors come from a plan that was
 * mid-update), then offers a button. Changing `resetKey` (tab, space)
 * clears it too.
 */
import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode; resetKey?: string; label?: string };
type State = { error: Error | null; retried: boolean; key?: string };

export class NextBoundary extends Component<Props, State> {
  state: State = { error: null, retried: false, key: this.props.resetKey };
  private timer: number | undefined;

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { error: null, retried: false, key: props.resetKey };
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[next] view crashed', error);
    if (!this.state.retried) {
      this.timer = window.setTimeout(() => this.setState({ error: null, retried: true }), 400);
    }
  }

  componentWillUnmount() {
    window.clearTimeout(this.timer);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (!this.state.retried) return null;
    return (
      <div className="n3-broken" role="alert">
        <p className="n3-broken-title">{this.props.label ?? 'This part'} did not load.</p>
        <p className="n3-broken-line">Your list is safe. Nothing was changed.</p>
        <button type="button" className="n3-btn is-secondary" onClick={() => this.setState({ error: null, retried: false })}>
          Try again
        </button>
      </div>
    );
  }
}
