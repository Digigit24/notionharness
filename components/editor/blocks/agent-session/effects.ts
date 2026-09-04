import { AgentSessionBlockComponent } from './agent-session-block'

export function effects() {
  if (!customElements.get('notionforge-agent-session-block')) {
    customElements.define('notionforge-agent-session-block', AgentSessionBlockComponent)
  }
}
