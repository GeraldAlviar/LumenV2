// The physical square never changes position during a test. Status text lives
// outside it. Rendering acknowledgements mean a browser paint, not a guarantee
// that the physical panel/camera has settled; the phone waits separately.
import { hex, clamp } from './colour.js?v=2.1.0';
import { withDeadline } from './async.js?v=2.1.0';
export class DisplayStage {
  constructor(doc = document) { this.doc = doc; this.renderGeneration = 0; }
  show(msg) {
    const d = this.doc, board = d.querySelector('#calibration-board');
    const css = values => hex(values.map(v => clamp(v, 0, 1) * 255));
    d.body.classList.add('measuring');
    board.classList.toggle('field-layout', msg.layout === 'field');
    d.querySelector('#patch-anchor').style.background = css([msg.anchor ?? 0.5, msg.anchor ?? 0.5, msg.anchor ?? 0.5]);
    d.querySelector('#patch-test').style.background = css(msg.test);
    d.querySelector('#patch-field').classList.toggle('hidden', msg.layout !== 'field');
    d.querySelector('#patch-field').style.background = css(msg.test);
    for (const id of ['patch-anchor', 'patch-test']) d.querySelector('#' + id).classList.toggle('hidden', msg.layout === 'field');
    d.querySelector('#alignment-instruction').classList.toggle('hidden', msg.layout !== 'alignment');
  }
  async render(msg) {
    const generation = ++this.renderGeneration;
    if (this.doc.hidden) throw new Error('Monitor tab is hidden. Bring it to the front.');
    this.show(msg);
    await withDeadline(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), 1800, 'Monitor paint timed out. Keep its tab visible.');
    if (this.doc.hidden || generation !== this.renderGeneration) throw new Error('Monitor rendering was interrupted. Realign and resume.');
    return performance.now();
  }
  pause() {
    ++this.renderGeneration;
    this.show({ layout: 'alignment', test: [0.65, 0.65, 0.65], anchor: 0.5, label: 'Paused' });
  }
  hide() { ++this.renderGeneration; this.doc.body.classList.remove('measuring'); }
}
