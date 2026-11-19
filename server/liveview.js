// Live view of the form filling: a step feed and the latest screenshot from the headless browser.
// Kept in memory only. Screenshots can show what was typed into a form, so nothing is written to disk,
// and the view is cleared when the next run starts.
const MAX_STEPS = 200;

export class LiveView {
  constructor() {
    this.reset();
  }

  reset() {
    this.steps = [];
    this.image = null; // base64 JPEG of the latest screenshot
    this.imageAt = 0;
    this.seq = 0;
  }

  step(host, text, jpeg = null) {
    this.seq += 1;
    this.steps.push({ n: this.seq, at: Date.now(), host: host || "", text: String(text).slice(0, 300) });
    if (this.steps.length > MAX_STEPS) this.steps.splice(0, this.steps.length - MAX_STEPS);
    if (jpeg) {
      this.image = Buffer.from(jpeg).toString("base64");
      this.imageAt = Date.now();
    }
  }

  snapshot() {
    return {
      steps: this.steps.slice(-60),
      image: this.image,
      imageAt: this.imageAt,
      stepCount: this.seq,
    };
  }
}
