/**
 * The announcement message, as a pure function of a body and a context.
 *
 * Nothing in this file touches Prisma, discord.js, or `req`. That is what makes
 * the preview worth anything: the admin endpoint, the manual send, and the cron
 * task all render through here, so a preview and the message students read are
 * the same string produced by the same code from the same inputs. A renderer
 * that reached for the database would be a second implementation waiting to
 * disagree with the first.
 */

/**
 * The placeholders an admin may use. Anything else is rejected on save.
 *
 * Kept small on purpose. Every entry is a value that would otherwise be typed
 * into the body and drift — the closing time most of all, which is the reason
 * this feature exists.
 */
export const ANNOUNCEMENT_PLACEHOLDERS = [
  'date',
  'close_time',
  'daily_update_channel_id',
  'attendance_form_link',
  'termination_day',
] as const;

export type TAnnouncementPlaceholder =
  (typeof ANNOUNCEMENT_PLACEHOLDERS)[number];

/** Everything the body can refer to, resolved from live sources by the caller. */
export type TAnnouncementContext = {
  /** `YYYY-MM-DD`, Asia/Dhaka. From `getDhakaDate()`, never from a slice. */
  date: string;
  /** `HH:mm`, read from the daily-update schedule so the two cannot disagree. */
  closeTime: string;
  /** The channel snowflake; rendered as a working `<#id>` link. */
  dailyUpdateChannelId: string;
  attendanceFormLink: string;
  terminationDay: number;
};

/** Discord's hard limit on a single message. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * The message the program posts by hand today, from `attendenace.txt`, with its
 * placeholders intact and Discord's own markdown applied.
 *
 * ── The body is Discord markdown, passed through verbatim ─────────────────
 * `postAttendanceAnnouncement` sends this as plain `content`, and nothing
 * between here and Discord escapes it — so `#` headings, `**bold**`, `-` lists
 * and fenced code blocks arrive as formatting rather than as literal
 * characters. That is why the default carries them: an announcement ~5,000
 * students skim needs its sections and its deadline findable at a glance, and
 * an unstyled wall of text is read by nobody.
 *
 * Formatting changes nothing about who gets notified. `allowedMentions` still
 * names every ping explicitly, so an `@everyone` typed into a heading is as
 * inert as one typed into a paragraph.
 *
 * The update format is a bulleted list with bold labels rather than a fenced
 * code block. A fence is more copy-friendly, but the four field names are what
 * a student has to read and reproduce, and bold labels in a list is how the
 * rest of the message is structured — one visual language beats one convenient
 * copy button.
 *
 * This is what the row is born with, so deploying the feature does not silently
 * change what students read. The file's trailing "Need to mention roles" line is
 * an instruction to the implementer rather than part of the message, and is not
 * stored — the mentions are the structured allowlist, appended after the body.
 */
export const DEFAULT_ANNOUNCEMENT_BODY = `# 📢 ডেইলি অ্যাটেন্ডেন্স ও আপডেট
### 📅 Date: {{date}}

সবাই রাত **{{close_time}}** এর মধ্যে অ্যাটেন্ডেন্স ফর্ম ফিলাপ করবেন এবং {{daily_update_channel_id}} চ্যানেলে নিচের দেওয়া ফরম্যাট অনুযায়ী আপডেট দিবেন, এই চ্যানেলটি রাত **{{close_time}}** অবধি ওপেন থাকবে।

## 📝 অ্যাটেন্ডেন্স ফর্ম
{{attendance_form_link}}

## 🧾 আপডেট শেয়ার করার ফরম্যাট
সবাইকে প্রতিদিন নিচের ফরম্যাট অনুযায়ী এই চ্যানেলে লার্নিং আপডেট দিতে হবে:
- **Date:**
- **Learning Hour:**
- **What I Learned Today:**
- **My Target for Tomorrow:**

## ⚠️ টার্মিনেশন অ্যালার্ট
টানা **{{termination_day}} দিন** ডেইলি আপডেট এবং অ্যাটেন্ডেন্স দিতে ব্যর্থ হলে কোনো অগ্রিম নোটিশ ছাড়াই প্রসেস থেকে রিমুভ করা হবে।`;

/**
 * Matches a `{{ token }}` with optional inner whitespace.
 *
 * Deliberately permissive about spacing and deliberately strict about the token
 * itself: `{{ close_time }}` is what an admin copying from a dashboard hint will
 * produce, while `{{close time}}` is a mistake worth naming rather than
 * silently ignoring.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const isSupported = (token: string): token is TAnnouncementPlaceholder =>
  (ANNOUNCEMENT_PLACEHOLDERS as readonly string[]).includes(token);

/**
 * Substitutes every supported placeholder, every time it occurs.
 *
 * `{{daily_update_channel_id}}` renders as `<#id>` so it is a channel students
 * can click rather than a bare number.
 *
 * An unsupported placeholder is left as literal text rather than blanked. Save
 * validation is what stops one from ever being stored; if one somehow reaches
 * this point — a body saved before a placeholder was retired — a slightly wrong
 * message at 7 PM beats no message at all, and the literal token makes the
 * problem obvious to whoever reads the channel.
 */
export const renderAnnouncement = (
  body: string,
  context: TAnnouncementContext,
): string => {
  const values: Record<TAnnouncementPlaceholder, string> = {
    date: context.date,
    close_time: context.closeTime,
    daily_update_channel_id: `<#${context.dailyUpdateChannelId}>`,
    attendance_form_link: context.attendanceFormLink,
    termination_day: String(context.terminationDay),
  };

  return body.replace(PLACEHOLDER_PATTERN, (match, token: string) =>
    isSupported(token) ? values[token] : match,
  );
};

/**
 * Every `{{…}}` token in the body that is not supported, deduplicated and in the
 * order they appear.
 *
 * Used by save validation so a typo fails where an admin is watching, rather
 * than in a message thousands of students read with a literal
 * `{{attendance_link}}` in the middle of it.
 */
export const findUnsupportedPlaceholders = (body: string): string[] => {
  const unsupported = new Set<string>();

  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const token = match[1] ?? '';

    if (!isSupported(token)) unsupported.add(token);
  }

  return [...unsupported];
};

export type TMentionLineInput = {
  everyone: boolean;
  roleIds: string[];
  userIds: string[];
};

/**
 * The trailing mention line, or an empty string when there is nothing to
 * mention.
 *
 * Appended after the body rather than substituted into it. A `{{mentions}}`
 * placeholder would let an admin delete the mentions by editing the text — a
 * silent failure of half of what this feature is for. The demo message carries
 * its mentions at the end anyway.
 *
 * `@everyone` comes first because that is how the guild reads it: the broadest
 * audience, then roles, then individuals.
 */
export const buildMentionLine = ({
  everyone,
  roleIds,
  userIds,
}: TMentionLineInput): string => {
  const parts = [
    ...(everyone ? ['@everyone'] : []),
    ...roleIds.map((id) => `<@&${id}>`),
    ...userIds.map((id) => `<@${id}>`),
  ];

  return parts.join(' ');
};

/**
 * The complete message: rendered body, then the mention line on its own line.
 *
 * One place that assembles the two, so the length checked on save is the length
 * that goes to Discord.
 */
export const composeAnnouncement = (
  renderedBody: string,
  mentionLine: string,
): string => (mentionLine ? `${renderedBody}\n\n${mentionLine}` : renderedBody);
