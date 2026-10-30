import { describe, expect, it } from 'vitest';
import {
  baseRisk,
  destructiveShortcut,
  highRiskReason,
  isHighRiskControl,
  isMultilineEditor,
  isMutating,
  isPaymentFrame,
  isSecretField,
  isPasteKey,
  isTextInsertingKey,
  isTextProducingKey,
  keyRisk,
  needsKnownFocus,
  parseKey,
  producedChar,
  wordsOf,
} from '../../src/safety/classify.js';
import * as shared from '../../src/shared/secrets.js';
import { button, el, req } from './fixtures.js';

describe('wordsOf', () => {
  it('splits camelCase, snake_case, kebab-case and brackets', () => {
    expect(wordsOf('loginPassword')).toBe('login password');
    expect(wordsOf('user[card_number]')).toBe('user card number');
    expect(wordsOf('OTPCode')).toBe('otp code');
    expect(wordsOf('cc-exp-month')).toBe('cc exp month');
  });
});

describe('isSecretField', () => {
  it.each<[string, Partial<Parameters<typeof el>[0]>]>([
    ['type=password', { inputType: 'password' }],
    ['type=PASSWORD', { inputType: 'PASSWORD' }],
    ['autocomplete current-password', { autocomplete: 'current-password' }],
    ['autocomplete section + new-password', { autocomplete: 'section-login new-password' }],
    ['autocomplete one-time-code', { autocomplete: 'one-time-code' }],
    ['autocomplete cc-number', { autocomplete: 'billing cc-number' }],
    ['autocomplete cc-csc', { autocomplete: 'cc-csc' }],
    ['autocomplete cc-exp-month', { autocomplete: 'cc-exp-month' }],
    ['name=password', { nameAttr: 'password' }],
    ['id=loginPassword', { idAttr: 'loginPassword' }],
    ['name=user_passwd', { nameAttr: 'user_passwd' }],
    ['name=pwd', { nameAttr: 'pwd' }],
    ['label Passcode', { labelText: 'Passcode' }],
    ['placeholder 6-digit verification code', { placeholder: 'Enter 6-digit verification code' }],
    ['aria-label OTP', { ariaLabel: 'OTP' }],
    ['name=otp_code', { nameAttr: 'otp_code' }],
    ['name=totp', { nameAttr: 'totp' }],
    ['label 2FA code', { labelText: '2FA code' }],
    ['label MFA', { labelText: 'MFA token' }],
    ['label Security code', { labelText: 'Security code' }],
    ['name=cvv', { nameAttr: 'cvv' }],
    ['name=cvc2', { nameAttr: 'cvc2' }],
    ['name=cardNumber', { nameAttr: 'cardNumber' }],
    ['name=cardnumber', { nameAttr: 'cardnumber' }],
    ['id=ccnum', { idAttr: 'ccnum' }],
    ['label Expiry date', { labelText: 'Expiry date' }],
    ['label IBAN', { labelText: 'IBAN' }],
    ['label Routing number', { labelText: 'Routing number' }],
    ['label Account number', { labelText: 'Account number' }],
    ['label SSN', { labelText: 'SSN' }],
    ['label Social Insurance Number', { labelText: 'Social Insurance Number' }],
    ['label SIN', { labelText: 'SIN' }],
    ['label PIN', { labelText: 'PIN' }],
    ['label API key', { labelText: 'API key' }],
    ['label Recovery phrase', { labelText: 'Recovery phrase' }],
    ['accessible name Password', { name: 'Password' }],
    ['stripe frame', { frameUrl: 'https://js.stripe.com/v3/elements-inner-card.html' }],
    ['paypal frame', { frameUrl: 'https://www.paypal.com/smart/card-fields' }],
    ['braintree frame', { frameUrl: 'https://assets.braintreegateway.com/web/hosted-fields' }],
    ['adyen frame', { frameUrl: 'https://checkoutshopper-live.adyen.com/x' }],
    ['checkout.com frame', { frameUrl: 'https://js.checkout.com/frames' }],
    ['google pay frame', { frameUrl: 'https://pay.google.com/gp/p/ui' }],
  ])('secret: %s', (_label, over) => {
    expect(isSecretField(el(over))).toBe(true);
  });

  it.each<[string, Partial<Parameters<typeof el>[0]>]>([
    ['plain text', { nameAttr: 'q', labelText: 'Search' }],
    ['email', { inputType: 'email', autocomplete: 'username', nameAttr: 'email' }],
    ['postal code', { labelText: 'Postal code', nameAttr: 'postalCode' }],
    ['zip code', { labelText: 'ZIP code' }],
    ['promo code', { labelText: 'Promo code' }],
    ['passport', { labelText: 'Passport number' }],
    ['passenger name', { labelText: 'Passenger name' }],
    ['subject', { labelText: 'Subject' }],
    ['message body', { role: 'textbox', name: 'Message Body', tag: 'div' }],
    ['shipping name', { autocomplete: 'shipping name' }],
    ['spinning', { labelText: 'Spinning class' }],
    ['hotpot', { labelText: 'Hotpot order notes' }],
    ['stripe docs page frame', { frameUrl: 'https://stripe.com/docs' }],
    ['paypal lookalike frame', { frameUrl: 'https://paypal.com.evil.com/' }],
  ])('not secret: %s', (_label, over) => {
    expect(isSecretField(el(over))).toBe(false);
  });

  it('#13: uses the ONE shared definition (src/shared/secrets.ts)', async () => {
    const classify = await import('../../src/safety/classify.js');
    expect(classify.SECRET_TEXT_RE).toBe(shared.SECRET_TEXT_RE);
    expect(classify.wordsOf).toBe(shared.wordsOf);
    for (const host of shared.PAYMENT_FRAME_DOMAINS) {
      const h = host.replace(/^\*\./, 'x.');
      expect(isPaymentFrame(`https://${h}/frame`), host).toBe(true);
    }
    // shared-list additions (French labels, hooks.stripe.com) are honoured by the gate
    expect(isSecretField(el({ labelText: 'Mot de passe' }))).toBe(true);
    expect(isPaymentFrame('https://hooks.stripe.com/x')).toBe(true);
    const domains = await import('../../src/safety/domains.js');
    expect('PAYMENT_FRAME_DOMAINS' in domains).toBe(false);
  });
  it('isPaymentFrame ignores non-web frames', () => {
    expect(isPaymentFrame('about:blank')).toBe(false);
    expect(isPaymentFrame('')).toBe(false);
  });
});

describe('isHighRiskControl', () => {
  it.each([
    'Send',
    'Send ‪(⌘Enter)‬',
    'Submit',
    'Pay now',
    'Buy now',
    'Place order',
    'Proceed to checkout',
    'Confirm',
    'Delete',
    'Delete forever',
    'Remove',
    'Move to trash',
    'Discard draft',
    'Archive all',
    'Unsubscribe',
    'Post',
    'Repost',
    'Publish',
    'Share',
    'Invite people',
    'Transfer funds',
    'Withdraw',
    'Authorize',
    'Authorise app',
    'Allow',
    'Accept all',
    'Grant access',
    'Sign in',
    'Sign up',
    'Subscribe',
    'Reply all',
    'Forward',
    'Donate',
  ])('high risk: %s', (name) => {
    expect(isHighRiskControl(button(name))).toBe(true);
  });

  it.each(['Inbox', 'Postal code', 'Posts', 'Compose', 'Next', 'Search', 'Paypal balance', 'Settings', 'Signature', 'Sender info', 'Older'])(
    'not high risk: %s',
    (name) => {
      expect(isHighRiskControl(button(name))).toBe(false);
    },
  );

  it('uses text and aria-label as well as name', () => {
    expect(isHighRiskControl(button('', { text: 'Send', name: '' }))).toBe(true);
    expect(isHighRiskControl(button('', { ariaLabel: 'Delete message', text: null }))).toBe(true);
  });

  it('a submit control is high risk whatever its label', () => {
    expect(isHighRiskControl(button('Go', { isSubmit: true }))).toBe(true);
  });

  it.each([
    // #12: multilingual
    'Envoyer', 'Supprimer', 'Enviar', 'Eliminar', 'Borrar', 'Löschen', 'LÖSCHEN', 'Senden', 'Absenden', 'Excluir',
    'Elimina', 'Invia', 'Pagar', 'Payer', 'Bezahlen', 'Kaufen', 'Jetzt kaufen', 'Acheter', 'Comprar', 'Publier',
    'Publicar', 'Veröffentlichen', 'Teilen', 'Partager', 'Compartir', 'Transférer', 'Zahlungspflichtig bestellen',
    'Verwijderen', 'Отправить', 'Удалить', '送信', '削除する', '发送', '삭제',
    // #12: Gmail / Outlook specific
    'Create filter', 'Mark as spam', 'Report spam', 'Report phishing', 'Block "Bob"', 'Empty Trash now',
    'Delete forever', 'Mute', 'Discard drafts', 'Send now', 'Comment', 'Merge pull request', 'Approve',
  ])('high risk (multilingual / app-specific): %s', (name) => {
    expect(isHighRiskControl(button(name))).toBe(true);
  });

  it.each(['Sender name', 'Sent', 'Sending options', 'Deleted items', 'Envoyés', 'Löschung', 'Paysage', 'Shared with me', 'Blocked senders', 'Comments', 'Ordinateur', 'Resender'])(
    'word boundaries keep %s low risk',
    (name) => {
      expect(isHighRiskControl(button(name))).toBe(false);
    },
  );

  it('reports the matched word', () => {
    expect(highRiskReason(button('Supprimer la conversation'))).toBe('supprimer');
    expect(highRiskReason(button('Send  now'))).toBe('send now');
  });
});

describe('keys', () => {
  it('parses combos', () => {
    const k = parseKey('Control+Shift+K');
    expect([...k.modifiers].sort()).toEqual(['control', 'shift']);
    expect(k.key).toBe('K');
    expect(parseKey('Shift++').key).toBe('+');
    expect(parseKey('Enter').modifiers.size).toBe(0);
  });
  it.each([
    ['Meta+Enter', 'high'],
    ['Control+Enter', 'high'],
    ['Ctrl+Enter', 'high'],
    ['cmd+enter', 'high'],
    ['Meta+NumpadEnter', 'high'],
    ['Enter', 'low'],
    ['Shift+Enter', 'low'],
    ['Meta+A', 'low'],
    ['Escape', 'low'],
    ['Delete', 'medium'],
  ])('keyRisk(%s) = %s', (k, r) => {
    expect(keyRisk(k)).toBe(r);
  });
  it.each([
    ['a', 'a'], ['A', 'A'], ['KeyA', 'a'], ['Shift+KeyA', 'A'], ['Digit1', '1'], ['Shift+Digit1', '!'], ['Shift+3', '#'],
    ['Numpad1', '1'], ['Space', ' '], [' ', ' '], ['Shift+ ', ' '], ['Semicolon', ';'], ['NumpadAdd', '+'], ['é', 'é'],
    ['Enter', null], ['Tab', null], ['ArrowDown', null], ['F5', null], ['Backspace', null],
  ])('producedChar(%s) = %s', (k, ch) => {
    expect(producedChar(parseKey(k))).toBe(ch);
  });
  it('#3 text-producing keys (KeyA, Digit1, Numpad1, Space, single chars; Alt counts, Ctrl/Meta do not)', () => {
    for (const k of ['KeyA', 'Digit1', 'Numpad1', 'Space', 'x', '#', 'Alt+KeyA', 'Shift+KeyZ', 'Quote']) expect(isTextProducingKey(k), k).toBe(true);
    for (const k of ['Meta+KeyA', 'Control+c', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'PageDown']) expect(isTextProducingKey(k), k).toBe(false);
  });
  it('paste combos', () => {
    for (const k of ['Meta+V', 'Control+v', 'Control+KeyV', 'Meta+Shift+V', 'Shift+Insert', 'Paste']) expect(isPasteKey(k), k).toBe(true);
    for (const k of ['v', 'Insert', 'Meta+C']) expect(isPasteKey(k), k).toBe(false);
  });
  it('keys that need a known focus', () => {
    for (const k of ['a', 'Meta+V', 'Enter', 'NumpadEnter', 'Tab', 'Backspace', 'Delete', 'Meta+Backspace']) expect(needsKnownFocus(k), k).toBe(true);
    for (const k of ['ArrowDown', 'Escape', 'PageUp', 'Home', 'Meta+A', 'F5']) expect(needsKnownFocus(k), k).toBe(false);
  });
  it('destructive shortcuts', () => {
    for (const k of ['Delete', 'Backspace', 'Shift+Delete', '#', 'Shift+3', 'Shift+Digit3', '!', 'Shift+1']) expect(destructiveShortcut(k), k).not.toBeNull();
    for (const k of ['e', 'Shift+I', 'j', 'k', 'ArrowDown', 'Escape', 'Meta+3']) expect(destructiveShortcut(k), k).toBeNull();
  });
  it('text-inserting keys', () => {
    expect(isTextInsertingKey('a')).toBe(true);
    expect(isTextInsertingKey('Shift+A')).toBe(true);
    expect(isTextInsertingKey('Meta+V')).toBe(true);
    expect(isTextInsertingKey('Control+v')).toBe(true);
    expect(isTextInsertingKey('KeyA')).toBe(true);
    expect(isTextInsertingKey('Numpad1')).toBe(true);
    expect(isTextInsertingKey('Enter')).toBe(false);
    expect(isTextInsertingKey('Meta+A')).toBe(false);
    expect(isTextInsertingKey('ArrowDown')).toBe(false);
  });
});

describe('action classification', () => {
  it('mutating kinds', () => {
    expect(isMutating('read')).toBe(false);
    expect(isMutating('scroll')).toBe(false);
    expect(isMutating('hover')).toBe(false);
    for (const k of ['navigate', 'click', 'type', 'select', 'press', 'upload', 'dialog', 'evaluate', 'tab_open', 'tab_close'] as const) {
      expect(isMutating(k)).toBe(true);
    }
  });
  it('base risk', () => {
    expect(baseRisk(req({ kind: 'read' }))).toBe('low');
    expect(baseRisk(req({ kind: 'click' }))).toBe('medium');
    expect(baseRisk(req({ kind: 'upload' }))).toBe('high');
    expect(baseRisk(req({ kind: 'press', key: 'Enter' }))).toBe('low');
    expect(baseRisk(req({ kind: 'press', key: 'Meta+Enter' }))).toBe('high');
  });
  it('multiline editors', () => {
    expect(isMultilineEditor(el({ tag: 'textarea' }))).toBe(true);
    expect(isMultilineEditor(el({ tag: 'div', isEditable: true }))).toBe(true);
    expect(isMultilineEditor(el({ tag: 'input' }))).toBe(false);
  });
});
