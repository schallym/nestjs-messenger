import type { FailedMessageView } from '../transport';

const COLUMNS = ['Id', 'Class', 'Failed at', 'Retries', 'Error'] as const;

function formatDate(date: Date | undefined): string {
  return date === undefined ? '-' : date.toISOString();
}

function row(view: FailedMessageView): readonly string[] {
  return [
    view.id,
    view.messageType,
    formatDate(view.failedAt),
    String(view.redeliveryCount),
    view.error ?? '-',
  ];
}

function columnWidths(rows: readonly (readonly string[])[]): number[] {
  return COLUMNS.map((header, index) =>
    Math.max(
      header.length,
      // The `?? ''` is a noUncheckedIndexedAccess formality: every row carries all COLUMNS.
      ...rows.map((cells) => /* istanbul ignore next -- @preserve */ (cells[index] ?? '').length),
    ),
  );
}

function padRow(cells: readonly string[], widths: readonly number[]): string {
  // `widths[index] ?? 0` is a noUncheckedIndexedAccess formality: widths has one entry per cell.
  return cells
    .map((cell, index) => cell.padEnd(/* istanbul ignore next -- @preserve */ widths[index] ?? 0))
    .join('  ');
}

/** Render the dead-letter list as an aligned table, mirroring `messenger:failed:show`. */
export function renderFailedMessageTable(views: readonly FailedMessageView[]): string {
  if (views.length === 0) {
    return 'No failed messages.';
  }
  const rows = views.map((view) => row(view));
  const widths = columnWidths(rows);
  const header = padRow(COLUMNS, widths);
  const separator = '-'.repeat(header.length);
  return [header, separator, ...rows.map((cells) => padRow(cells, widths))].join('\n');
}

/** Render a single dead-lettered message in detail, with copy-paste retry/remove hints. */
export function renderFailedMessageDetail(view: FailedMessageView): string {
  return [
    `Id:               ${view.id}`,
    `Class:            ${view.messageType}`,
    `Failed at:        ${formatDate(view.failedAt)}`,
    `Original transport: ${view.originalTransport ?? '-'}`,
    `Redeliveries:     ${String(view.redeliveryCount)}`,
    `Error class:      ${view.errorClass ?? '-'}`,
    `Error:            ${view.error ?? '-'}`,
    '',
    `Run "messenger:failed:retry ${view.id}" to retry it.`,
    `Run "messenger:failed:remove ${view.id}" to discard it.`,
  ].join('\n');
}
