import type { FailedMessageView } from '../src';
import {
  renderFailedMessageDetail,
  renderFailedMessageTable,
} from '../src/cli/failed-message.presenter';

const fullView: FailedMessageView = {
  id: '1620-0',
  messageType: 'SendEmailMessage',
  error: 'SMTP timeout',
  errorClass: 'TransportError',
  redeliveryCount: 3,
  failedAt: new Date('2026-05-30T10:00:00.000Z'),
  originalTransport: 'async',
};

const sparseView: FailedMessageView = {
  id: '7',
  messageType: 'BareMessage',
  error: undefined,
  errorClass: undefined,
  redeliveryCount: 0,
  failedAt: undefined,
  originalTransport: undefined,
};

describe('failed-message presenter', () => {
  describe('renderFailedMessageTable', () => {
    it('reports an empty failure transport', () => {
      expect(renderFailedMessageTable([])).toBe('No failed messages.');
    });

    it('renders a header and one aligned row per message', () => {
      const table = renderFailedMessageTable([fullView]);
      const lines = table.split('\n');

      expect(lines[0]).toContain('Id');
      expect(lines[0]).toContain('Class');
      expect(lines[0]).toContain('Failed at');
      expect(lines[0]).toContain('Error');
      expect(lines[1]).toMatch(/^-+$/);
      expect(lines[2]).toContain('1620-0');
      expect(lines[2]).toContain('SendEmailMessage');
      expect(lines[2]).toContain('2026-05-30T10:00:00.000Z');
      expect(lines[2]).toContain('SMTP timeout');
    });

    it('renders placeholders for a message with no error or timestamp', () => {
      const row = renderFailedMessageTable([sparseView]).split('\n', 3)[2] ?? '';
      // failedAt and error both collapse to "-"
      expect(row).toContain('BareMessage');
      expect(row.match(/-/g)?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('renderFailedMessageDetail', () => {
    it('renders every field and retry/remove hints', () => {
      const detail = renderFailedMessageDetail(fullView);

      expect(detail).toContain('1620-0');
      expect(detail).toContain('SendEmailMessage');
      expect(detail).toContain('async');
      expect(detail).toContain('TransportError');
      expect(detail).toContain('SMTP timeout');
      expect(detail).toContain('messenger:failed:retry 1620-0');
      expect(detail).toContain('messenger:failed:remove 1620-0');
    });

    it('renders placeholders when error/transport are absent', () => {
      const detail = renderFailedMessageDetail(sparseView);
      expect(detail).toContain('Original transport: -');
      expect(detail).toContain('Error:            -');
    });
  });
});
