import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Renders one PDF page per slide, fitted to the window, with neighbours pre-rendered for instant flips. */
export class PdfDeck {
  page = 1;
  private doc: PDFDocumentProxy | null = null;
  private cache = new Map<number, Promise<HTMLCanvasElement>>();
  private cacheKey = '';
  private drawSeq = 0;

  constructor(private readonly target: HTMLCanvasElement) {}

  get total(): number {
    return this.doc?.numPages ?? 0;
  }

  async open(data: ArrayBuffer): Promise<void> {
    await this.close();
    this.doc = await pdfjs.getDocument({ data }).promise;
    this.page = 1;
    await this.draw();
  }

  async close(): Promise<void> {
    this.cache.clear();
    const doc = this.doc;
    this.doc = null;
    await doc?.destroy();
  }

  go(delta: number): boolean {
    const next = Math.min(Math.max(this.page + delta, 1), this.total);
    if (next === this.page) return false;
    this.page = next;
    void this.draw();
    return true;
  }

  /** Call after window resize. */
  async draw(): Promise<void> {
    if (!this.doc) return;
    const seq = ++this.drawSeq;
    const canvas = await this.render(this.page);
    if (seq !== this.drawSeq) return; // a newer flip won
    const t = this.target;
    t.width = canvas.width;
    t.height = canvas.height;
    t.style.width = canvas.style.width;
    t.style.height = canvas.style.height;
    t.getContext('2d')!.drawImage(canvas, 0, 0);
    // Warm neighbours; forward first since that is the common direction.
    for (const n of [this.page + 1, this.page - 1, this.page + 2]) {
      if (n >= 1 && n <= this.total) void this.render(n);
    }
    this.evict();
  }

  private render(n: number): Promise<HTMLCanvasElement> {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${window.innerWidth}x${window.innerHeight}@${dpr}`;
    if (key !== this.cacheKey) {
      this.cache.clear();
      this.cacheKey = key;
    }
    let job = this.cache.get(n);
    if (!job) {
      job = this.renderPage(n, dpr);
      this.cache.set(n, job);
      job.catch(() => this.cache.delete(n));
    }
    return job;
  }

  private async renderPage(n: number, dpr: number): Promise<HTMLCanvasElement> {
    const page = await this.doc!.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(window.innerWidth / base.width, window.innerHeight / base.height);
    const viewport = page.getViewport({ scale: fit * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    return canvas;
  }

  private evict(): void {
    for (const n of this.cache.keys()) {
      if (Math.abs(n - this.page) > 3) this.cache.delete(n);
    }
  }
}
