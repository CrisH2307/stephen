/**
 * ONE definition of "secret field" and "payment frame", shared by the safety gate (which refuses to
 * type into them) and the page engine (which redacts their values from snapshots). Keeping a single
 * list avoids the two disagreeing (review finding #13).
 *
 * The page runtime is serialized into the browser and cannot import this module: pass
 * SECRET_TEXT_SOURCE / SECRET_TEXT_FLAGS / SECRET_AUTOCOMPLETE to it as arguments and apply the
 * regex to wordsOf()-style text (the runtime re-implements wordsOf with identical rules).
 */

/** Exact autocomplete tokens that mark a secret field (plus any token starting with "cc-"). */
export const SECRET_AUTOCOMPLETE: readonly string[] = ['current-password', 'new-password', 'one-time-code'];
export const SECRET_AUTOCOMPLETE_PREFIX = 'cc-';

/**
 * Applied to word-split attribute text (name, id, label, placeholder, aria-label → wordsOf):
 * passwords, OTP/2FA codes, payment card data, bank account numbers, national ids, API secrets.
 */
export const SECRET_TEXT_SOURCE = [
  String.raw`\bpass ?(?:word|code|phrase)s?\b`,
  String.raw`\bpass(?:wd|wort)\b`,
  String.raw`\bmot de passe\b`,
  String.raw`\bcontrase(?:ñ|n)a\b`,
  String.raw`\bpwd?\b`,
  String.raw`\b[th]?otp\d*(?:code)?\b`,
  String.raw`\b(?:2fa|mfa|tfa)\b`,
  String.raw`\btwo ?(?:factor|step)\b`,
  String.raw`\b(?:verification|security|one ?time|auth|authentication|sms|login|backup|recovery) ?codes?\b`,
  String.raw`\bcode de (?:v(?:é|e)rification|s(?:é|e)curit(?:é|e))\b`,
  String.raw`\b(?:cvv|cvc|cvn|csc)\d?\b`,
  String.raw`\b(?:card|cc) ?(?:number|num|no)\b`,
  String.raw`\bnum(?:é|e)ro de (?:carte|compte)\b`,
  String.raw`\bccnum`,
  String.raw`\b(?:credit|debit) ?card\b`,
  String.raw`\bcarte de cr(?:é|e)dit\b`,
  String.raw`\bexpir(?:y|ation|es)\b`,
  String.raw`\bexp ?(?:date|month|year|mm|yy)\b`,
  String.raw`\biban\b`,
  String.raw`\brouting\b`,
  String.raw`\b(?:account|acct) ?(?:number|num|no)\b`,
  String.raw`\b(?:sort ?code|transit ?number|institution ?number)\b`,
  String.raw`\bssn\b`,
  String.raw`\bsocial ?(?:security|insurance)\b`,
  String.raw`\bnas\b`,
  String.raw`\bsin\b`,
  String.raw`\btax ?(?:id|payer id)\b`,
  String.raw`\bpin\b`,
  String.raw`\b(?:api|secret|private|access) ?(?:key|token)\b`,
  String.raw`\b(?:seed|recovery) ?phrase\b`,
  String.raw`\bmnemonic\b`,
  // ── review #2 finding 10: OTP phrasings
  String.raw`\b(?:confirmation|access|one ?time|signin|sign in|log ?in|email|text) ?codes?\b`,
  String.raw`\b\d+ ?digits?\b`,
  String.raw`\b(?:four|five|six|seven|eight) ?digits?\b`,
  String.raw`\bdigits\b`,
  String.raw`\b(?:digit|character|char) \d+ of \d+\b`, // split OTP boxes: "Digit 1 of 6"
  String.raw`^card(?: (?:details|info|information|data))?$`, // a field labelled just "Card" (payment)
  String.raw`\benter (?:the |your |this |that )?(?:\w+ )?code\b`,
  String.raw`\bcode (?:we |was |has been |that we )?(?:just )?sent\b`,
  String.raw`\bsent (?:you )?(?:a |the )?code\b`,
  String.raw`\b(?:m|sms|push|chip|photo)?tan(?: ?(?:code|nummer|number))\b`,
  String.raw`\b(?:m|sms|push|chip|photo) ?tan\b`,
  // security questions / answers / memorable words (the answer is a password substitute)
  String.raw`\b(?:security|secret|challenge|memorable) ?(?:questions?|answers?|words?|information|info)\b`,
  String.raw`\bmother'?s? maiden\b`,
  String.raw`\bmaiden name\b`,
  // ── passwords / PINs / codes in other languages. Words starting or ending with a non-ASCII letter
  // use (?<![a-z0-9]) / plain substrings instead of \b (JS \b is ASCII-only without the v flag).
  String.raw`kennw(?:o|ö|oe)rt`, // de
  String.raw`(?:best(?:ä|ae|a)tigungs|verifizierungs|sicherheits|einmal|zugangs|anmelde) ?(?:code|passwort|kennwort)`,
  String.raw`\bpin ?code\b`,
  String.raw`\bgeheimzahl`,
  String.raw`\bsenha`, // pt
  String.raw`c(?:ó|o)digo (?:de )?(?:verifica(?:ç|c)(?:ã|a)o|seguran(?:ç|c)a|confirma(?:ç|c)(?:ã|a)o|acesso|autentica(?:ç|c)(?:ã|a)o|verificaci(?:ó|o)n|seguridad|confirmaci(?:ó|o)n|acceso|autenticaci(?:ó|o)n|sms)`, // pt/es
  String.raw`\bclave (?:de acceso|secreta|de seguridad)`, // es
  String.raw`\bcodice (?:di )?(?:verifica|sicurezza|conferma|accesso|otp)\b`, // it
  String.raw`\bparola d ?'? ?ordine\b`,
  String.raw`(?<![a-z0-9])(?:ş|s)ifre`, // tr
  String.raw`(?:do(?:ğ|g)rulama|g(?:ü|u)venlik) ?kodu`, // tr
  String.raw`\bwachtwoord`, // nl
  String.raw`\b(?:verificatie|beveiligings|bevestigings|toegangs) ?code\b`,
  String.raw`\bhas(?:ł|l)o`, // pl
  String.raw`\bkod (?:weryfikacyjny|bezpiecze(?:ń|n)stwa|sms|dost(?:ę|e)pu|potwierdzaj(?:ą|a)cy)`,
  String.raw`\bl(?:ö|o)senord`, // sv
  String.raw`\badgangskode`, // da/no
  String.raw`\bsalasana`, // fi
  String.raw`\bheslo\b`, // cs/sk
  String.raw`\bjelsz(?:ó|o)`, // hu
  String.raw`\bparol(?:ă|a)(?![a-z])(?! chiave)`, // tr/ro "parola" = password; not it "parola chiave" (keyword)
  String.raw`\bcode (?:de )?confirmation\b`, // fr
  // Cyrillic / CJK: plain substrings (no word boundaries in these scripts, or ASCII \b does not apply)
  'пароль', 'паролю', 'пин код', 'пин-код', 'код подтверждения', 'код безопасности', 'проверочный код', 'одноразовый',
  'код из смс', 'код из sms', 'секретный вопрос', 'секретное слово', 'контрольный вопрос',
  'パスワード', '暗証番号', '認証コード', '確認コード', 'ワンタイム', 'セキュリティコード', '秘密の質問',
  '密码', '密碼', '口令', '验证码', '驗證碼', '校验码', '安全码', '动态码', '安全問題', '安全问题',
  '비밀번호', '암호', '인증번호', '인증 번호', '인증코드', '인증 코드', '보안코드', '보안 코드', '확인 코드', '확인코드',
].join('|');
export const SECRET_TEXT_FLAGS = 'i';
export const SECRET_TEXT_RE = new RegExp(SECRET_TEXT_SOURCE, SECRET_TEXT_FLAGS);

/** Split camelCase / snake_case / kebab-case / brackets into lowercase words: "loginPassword" → "login password". */
export function wordsOf(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.[\]:/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * True when the page engine reported independent evidence that a field is secret (ElementInfo.secretHint:
 * 'text-security', 'otp-digit-group', 'became-password', …). Any non-empty value counts.
 */
export function hintIsSecret(secretHint: string | null | undefined): boolean {
  return typeof secretHint === 'string' && secretHint.length > 0;
}

/** True if any of the given attribute strings, word-split, look like a secret field. */
export function textLooksSecret(...parts: Array<string | null | undefined>): boolean {
  return parts.some((p) => !!p && SECRET_TEXT_RE.test(wordsOf(p)));
}

export function autocompleteIsSecret(autocomplete: string | null | undefined): boolean {
  if (!autocomplete) return false;
  return autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((tok) => SECRET_AUTOCOMPLETE.includes(tok) || tok.startsWith(SECRET_AUTOCOMPLETE_PREFIX));
}

/**
 * Hosts of payment-processor frames: every value inside is secret. Pattern grammar as in
 * src/safety/domains.ts hostMatches(): 'domain' = itself + subdomains, '*.domain' = subdomains only.
 */
export const PAYMENT_FRAME_DOMAINS: readonly string[] = [
  'js.stripe.com', 'checkout.stripe.com', 'hooks.stripe.com', 'm.stripe.network', '*.paypal.com', '*.paypalobjects.com',
  '*.braintreegateway.com', '*.braintree-api.com', '*.adyen.com', '*.adyenpayments.com', '*.checkout.com',
  'pay.google.com', 'payments.google.com', 'applepay.cdn-apple.com', 'web.squarecdn.com', '*.squareup.com',
  'shopifycs.com', 'pci.shopifyinc.com', '*.authorize.net', '*.recurly.com', '*.chargebee.com', '*.paddle.com',
  '*.klarna.com',
];
