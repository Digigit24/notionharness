import { TaskBlockComponent } from './task-block'

export function effects() {
  if (!customElements.get('affine-task-block')) {
    customElements.define('affine-task-block', TaskBlockComponent)
  }
}
