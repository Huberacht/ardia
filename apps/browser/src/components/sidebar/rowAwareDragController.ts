import { DragController } from "./dragController";

export class RowAwareDragController extends DragController {
  beforeMeasure: (() => void) | null = null;
  private rowsPending = false;
  private refreshing = false;

  async begin(key: string, x: number, y: number) {
    this.beforeMeasure?.();
    await super.begin(key, x, y);
    this.refreshRows();
  }

  async beginExternal(count: number, x: number, y: number) {
    this.beforeMeasure?.();
    await super.beginExternal(count, x, y);
    this.refreshRows();
  }

  rowsArrived() {
    this.rowsPending = true;
    this.refreshRows();
  }

  get refreshingRows() {
    return this.refreshing || this.rowsPending;
  }

  private refreshRows() {
    const session = this.session;
    if (!session) this.rowsPending = false;
    if (!this.rowsPending || this.refreshing || !session?.measured) return;
    this.rowsPending = false;
    this.refreshing = true;
    const current = () => this.session === session;
    void this.measureAll(session, current).then((live) => {
      this.refreshing = false;
      if (live && current() && session.measured) this.move(session.pointer.x, session.pointer.y);
      this.refreshRows();
    });
  }
}
