import test from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegramMessage } from '../../src/channel/telegram/telegram-send.js';

test('sendTelegramMessage routes outbound images and files to Telegram media APIs', async () => {
  const photos = [];
  const documents = [];
  const api = {
    async sendMessage() {
      throw new Error('should not send text');
    },
    async sendPhoto(payload) {
      photos.push(payload);
      return { message_id: 'photo_1' };
    },
    async sendDocument(payload) {
      documents.push(payload);
      return { message_id: 'doc_1' };
    }
  };

  const result = await sendTelegramMessage(api, {
    conversationRef: {
      conversationId: '123',
      topicId: null
    },
    text: '',
    replyTo: '7',
    meta: {},
    attachments: [
      {
        kind: 'image',
        localPath: '/tmp/report.png',
        fileName: 'report.png',
        mimeType: 'image/png'
      },
      {
        kind: 'file',
        localPath: '/tmp/report.pdf',
        fileName: 'report.pdf',
        mimeType: 'application/pdf'
      }
    ]
  });

  assert.equal(result.message_id, 'photo_1');
  assert.equal(photos.length, 1);
  assert.equal(documents.length, 1);
  assert.equal(photos[0].filePath, '/tmp/report.png');
  assert.equal(documents[0].filePath, '/tmp/report.pdf');
  assert.equal(photos[0].replyTo, '7');
  assert.equal(documents[0].replyTo, undefined);
});
