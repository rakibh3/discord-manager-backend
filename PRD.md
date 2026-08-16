# Discord Daily Attendance & Update Automation

## Project Implementation Document (PID)

**Version:** 3.1 (Web Attendance Form & Official Discord Username Verification)  
**Primary Goal:** Discord server-এর attendance এবং daily update process automate করে একটি scalable, rate-limited admin dashboard ও reminder system তৈরি করা।

---

# 1. Project Overview

এই system-এ একটি Discord server থাকবে যেখানে আনুমানিক **৫,০০০ (5,000) users/students** থাকবে।

### System-এর প্রধান কাজ:

1. **Custom Web Attendance Form:** প্রতিদিন নির্দিষ্ট সময়ে একটি কাস্টম ওয়েব ফর্মের (`/attendance`) মাধ্যমে শিক্ষার্থীদের কাছ থেকে Attendance সংগ্রহ করা।
   - ফর্মে শুধুমাত্র ৪টি নির্দিষ্ট ফিল্ড থাকবে: **Full Name**, **Phone Number**, **Email**, এবং **Discord Username**।
2. **Official Discord Member Verification:** ফর্মে টাইপ করা Discord Username ডিসকর্ডের অফিসিয়াল ইউজারনেম স্ট্যান্ডার্ড মেনে ভ্যালিডেট হবে এবং রিয়েলটাইমে ডিসকর্ড সার্ভারের মেম্বার লিস্টের সাথে ম্যাচ করবে। সার্ভারে মেম্বার না থাকলে ফর্ম সাবমিট করা যাবে না।
3. **Scheduled Channel Access:** প্রতিদিন সন্ধ্যা **06:00 PM** থেকে রাত **11:59 PM (Asia/Dhaka)** পর্যন্ত `#daily-update` চ্যানেল open রাখা এবং মধ্যরাত **12:00 AM**-এ স্বয়ংক্রিয়ভাবে lock করা।
4. **Real-time Message Ingestion:** User `#daily-update` চ্যানেলে মেসেজ দেওয়ার সাথে সাথে real-time-এ database-এ স্টোর করা।
5. **Data Matching & Consolidation:** Web Attendance ডাটা এবং Discord-এর মেসেজ ডাটাকে ইউজারনেম ও Discord User ID-এর সাথে নিখুঁতভাবে ম্যাচ করা।
6. **Real-time Admin Dashboard:** ড্যাশবোর্ডে লাইভ মনিটরিং:
   - কে attendance দিয়েছে
   - কে daily update দিয়েছে
   - কে দুটোই দিয়েছে
   - কে কোনোটি দেয়নি
7. **Rate-Limited Missing Update Reminder:** রাত ১২টার পরে missing-update ইউজারদের চিহ্নিত করে BullMQ Queue-এর মাধ্যমে Discord Rate Limit মেনে নিরাপদভাবে ব্যক্তিগত DM পাঠানো।
8. **Closed DM Fallback:** যেসব ইউজারের DM বন্ধ (`Error 50007`), তাদের জন্য `#daily-update-reminder` চ্যানেলে ফলব্যাক ব্যাচ নোটিফিকেশন পাঠানো।
9. **Audit & Reporting:** সম্পূর্ণ রিমাইন্ডার হিস্ট্রি ডাটাবেসে রাখা এবং CSV/Excel রিপোর্ট এক্সপোর্ট করা।

---

# 2. High-Level Architecture

```text
                               +-----------------------------+
                               |        DISCORD SERVER       |
                               |         ~5,000 USERS        |
                               +--------------+--------------+
                                              |
                                              v
                                       +-------------+
                                       | Discord Bot |
                                       +------+------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
                     v                                                 v
           [Member Sync & Cache]                             #daily-update Channel
                     |                                                 |
                     v                                                 v
         +-----------------------+                            Real-time Message Events
         |  PostgreSQL Database  |                                     |
         | (Synced Guild Members)|                                     |
         +-----------+-----------+                                     |
                     ^                                                 |
                     | 1. Live Verify                                  |
                     |    Discord Username                             |
                     |                                                 |
        +------------+------------+                                    |
        |                         |                                    |
        | 2. Submit Attendance    |                                    |
        |                         |                                    |
        v                         v                                    |
  +-------------------------------------+                              |
  |      Web Attendance Form UI         |                              |
  |  • Full Name   • Phone Number       |                              |
  |  • Email       • Discord Username   |                              |
  +------------------+------------------+                              |
                     |                                                 |
                     v                                                 v
         +-------------------------------------------------------------------+
         |                       Backend Application                         |
         |                      (Express.js + TypeScript)                    |
         +---------------------------------+---------------------------------+
                                           |
                                           v
                             +---------------------------+
                             |    PostgreSQL Database    |
                             |       (Prisma ORM)        |
                             +-------------+-------------+
                                           |
                    +----------------------+----------------------+
                    |                                             |
                    v                                             v
          +-------------------+                         +-------------------+
          |   Dashboard API   |                         |  BullMQ + Redis   |
          +---------+---------+                         |   (Job Queue)     |
                    |                                   +---------+---------+
                    v                                             |
          +-------------------+                                   v
          |  Admin Dashboard  |                         +-------------------+
          | (Next.js/React)   |                         | Safe Rate-Limited |
          +---------+---------+                         |    Discord DMs    |
                    |                                   +---------+---------+
                    |                                             |
                    +────────────────── Trigger Reminder ─────────+
                                                                  |
                                                                  v
                                                        [If DM Closed Error]
                                                                  |
                                                                  v
                                                        Fallback Batch Ping in
                                                       #daily-update-reminder
```

---

# 3. Web Attendance Form & Discord Username Rules

### 3.1. Form Fields:

| ফিল্ডের নাম             | ইনপুট টাইপ |    রিকোয়ার্ড?    | ভ্যালিডেশন রুলস                                                    |
| ----------------------- | ---------- | :--------------: | ------------------------------------------------------------------ |
| **1. Full Name**        | `text`     |     **Yes**      | নূন্যতম ৩ অক্ষর, শুধুমাত্র বর্ণ ও স্পেস                            |
| **2. Phone Number**     | `tel`      |     **Yes**      | বৈধ মোবাইল নম্বর ফরম্যাট (যেমন: `01XXXXXXXXX` বা `+8801XXXXXXXXX`) |
| **3. Email**            | `email`    |     **Yes**      | স্ট্যান্ডার্ড ইমেইল ফরম্যাট (`user@example.com`)                   |
| **4. Discord Username** | `text`     | **Yes (Strict)** | Discord Official Pomelo Username Format + Live Server Member Check |

---

### 3.2. Official Discord Username Standard ([Official Discord Support Reference](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names)):

Discord-এর অফিসিয়াল **New Usernames & Display Names** গাইডলাইন অনুযায়ী:

#### ১. Username বনাম Display Name-এর স্পষ্ট পার্থক্য:

- **Username (ইউনিক হ্যান্ডেল):** ডিসকর্ডে প্রতিটি ইউজারের জন্য একটি একক এবং অনন্য আইডেন্টিফায়ার (যেমন: `rakib_dev` বা `@rakib_dev`)। এটি কোনো সার্ভার বা প্রোফাইলভেদে ডুপ্লিকেট হতে পারে না। ফর্ম ও ডাটাবেসে **শুধুমাত্র এই Username ব্যবহার করা হবে**।
- **Display Name (সার্ভার নাম):** সার্ভারে বা চ্যাটে বড় করে যে নামটি প্রদর্শিত হয় (যেমন: `Rakib Hasan ✨`)। এটি ইউনিক নয় এবং শিক্ষার্থীরা যেকোনো সময় এটি পরিবর্তন করতে পারে।

#### ২. Discord Username-এর অফিশিয়াল নিয়মাবলী (Official Rules):

1. **দৈর্ঘ্য:** অবশ্যই ২ থেকে ৩২ অক্ষরের মধ্যে হতে হবে (`2 - 32 characters`)।
2. **অনুমোদিত অক্ষর:**
   - ছোট হাতের ল্যাটিন বর্ণ (`a-z`)
   - সংখ্যা (`0-9`)
   - আন্ডারস্কোর (`_`)
   - ডট (`.`)
3. **নিষিদ্ধ অক্ষর ও ফরম্যাট:**
   - ডট (`.`) ও আন্ডারস্কোর (`_`) ছাড়া অন্য কোনো স্পেশাল ক্যারেক্টার অনুমোদিত নয়।
   - পরপর দুটি ডট (`..`) অনুমোদিত নয়।
   - কোনো স্পেস বা ডিসকর্ডের অবৈধ ক্যারেক্টার (`#`, `:`, `@`, ```` ইত্যাদি) দেওয়া যাবে না।
   - কোনো ডিসক্রিমিনেটর ট্যাগ (`#0000`) থাকবে না।
4. **শুরু বা শেষে `_` / `.` অনুমোদিত (Leading & Trailing Allowed):** ইউজারনেমের শুরুতে বা শেষে আন্ডারস্কোর (`_`) বা ডট (`.`) থাকতে পারে — যেমন: `itzazad_`, `.rabbil`, `shahriarratul.`। এগুলো কোনোভাবেই ব্লক করা যাবে না।

   > ⚠️ **যাচাইকৃত (Verified against live server):** ২,১৮৯ জন মেম্বারের মধ্যে **১১৫ জনের (৫.৩%)** ইউজারনেম শুরু বা শেষে `_` / `.` দিয়ে গঠিত। এদের ৫৯ জনের অ্যাকাউন্ট Pomelo রোলআউটের **পরে** তৈরি — অর্থাৎ এগুলো পুরোনো grandfathered নাম নয়, ডিসকর্ড এখনো এই নাম অনুমোদন করে। এই নিয়ম ব্লক করলে ১৯ জনে ১ জন শিক্ষার্থী কখনোই attendance দিতে পারবে না (Golden Rule 3-এর সাথে সরাসরি সংঘর্ষ)।

5. **কেস-ইনসেনসিটিভ (Case-Insensitive):** ডিসকর্ডে সব ইউজারনেম স্বয়ংক্রিয়ভাবে ছোট হাতের অক্ষরে কনভার্ট হয়ে স্টোর হয় (যেমন: `Rakib_Dev` ➔ `rakib_dev`)।

```typescript
/**
 * Official Discord Username Validation Regex
 * - 2 to 32 characters
 * - Only lowercase a-z, 0-9, underscore (_), period (.)
 * - Cannot have consecutive periods (..)
 * - Leading/trailing `_` and `.` ARE allowed (verified against the live server)
 * - A leading `@` is stripped by normalizeDiscordUsername before validation
 */
export const DISCORD_USERNAME_REGEX = /^(?!.*\.{2})[a-z0-9_.]{2,32}$/;

/**
 * Normalizes user input by trimming whitespace, removing leading '@', and converting to lowercase.
 */
export function normalizeDiscordUsername(rawUsername: string): string {
  return rawUsername.trim().replace(/^@+/, '').toLowerCase();
}
```

#### ৩. ফর্ম UI হেল্পার টেক্সট (Student Guidance):

শিক্ষার্থীরা যেন তাদের Display Name না দিয়ে সঠিক **Discord Username** ইনপুট দেয়, সেজন্য ফর্ম ফিল্ডের নিচে একটি ভিজ্যুয়াল গাইড থাকবে:

> ℹ️ **How to find your Discord Username:**  
> Discord অ্যাপের নিচে বাম কোণায় আপনার প্রোফাইল ছবিতে ক্লিক করুন ➔ আপনার নামের নিচে `@` চিহ্নের পরের ছোট হাতের নামটি হলো আপনার **Discord Username** (যেমন: `@rakib_dev` হলে শুধু `rakib_dev` লিখুন)।

---

### 3.3. Live Server Matching & Verification Flow:

ইউজার যখন ফর্মে তার Discord Username লিখবে:

```text
User types username: "rakib_dev"
                 │
                 ▼
    [Client-side Regex Check] ──INVALID──> Show error: "Invalid Discord username format"
                 │ VALID
                 ▼
    [Debounced API Call (500ms)] ──> GET /api/attendance/verify-user?username=rakib_dev
                 │
                 ▼
    [Backend checks Database / Discord Bot Cache]
                 │
        ┌────────┴────────┐
        ▼                 ▼
   [USER FOUND]      [USER NOT FOUND]
        │                 │
        ▼                 ▼
 • Show ✅ Verified      • Show ❌ Error
 • Display Avatar & Tag  • "এই Discord Username-টি আমাদের Discord সার্ভারে পাওয়া যায়নি।
 • Enable Submit Button     দয়া করে সঠিক ইউজারনেম দিন অথবা আগে সার্ভারে জয়েন করুন।"
                         • Disable Submit Button (ফর্ম সাবমিট ব্লক)
```

---

### 3.4. Duplicate Prevention (One Attendance Per Day):

- একই দিনে একজন ইউজার কেবল একবারই ফর্ম সাবমিট করতে পারবে।
- ভেরিফিকেশন কল চলাকালীন ব্যাকএন্ড চেক করবে ইউজার আজকের দিনে ইতিমধ্যে সাবমিট করেছে কিনা। সাবমিট করে থাকলে মেসেজ দেবে:  
  _⚠️ "আপনি আজকের (YYYY-MM-DD) জন্য ইতোমধ্যে attendance জমা দিয়েছেন।"_
- ডাটাবেস লেভেলে `@@unique([userId, attendanceDate])` কনস্ট্রেইন্ট থাকায় কোনো ডুপ্লিকেট রেকর্ড তৈরি হতে পারবে না।

---

# 4. Recommended Technology Stack

## Backend

- **Runtime:** Node.js (v20+ LTS)
- **Language:** TypeScript
- **Framework:** Express.js
- **Discord SDK:** `discord.js` (v14+)

## Database & ORM

- **Database:** PostgreSQL (v16+)
- **ORM:** Prisma ORM
- **Migration & Client:** `@prisma/client`, `@prisma/adapter-pg`

## Background Queue & Scheduler

- **Job Queue:** BullMQ + Redis (Safe DM delivery with rate-limiting & retries)
- **Cron Scheduler:** `node-cron` / BullMQ Repeatable Jobs (Dhaka Timezone `Asia/Dhaka`)

## Frontend (Attendance Form & Admin Dashboard)

- **Framework:** Next.js (App Router)
- **Styling:** Tailwind CSS
- **Live State:** Server-Sent Events (SSE) for broadcast progress

---

# 5. Phase 1 — Discord Server & Channel Setup

Server-এ ৩টি সুনির্দিষ্ট চ্যানেল থাকবে:

```text
📋 ATTENDANCE
    └── #attendance           (Attendance ওয়েব ফর্মের লিঙ্ক ও নোটিশ)

📝 DAILY UPDATE
    └── #daily-update         (সন্ধ্যা ৬টা থেকে রাত ১২টা পর্যন্ত মেসেজ পাঠানো যাবে)

🔔 REMINDER
    └── #daily-update-reminder (যাদের DM বন্ধ তাদের ফলব্যাক মেনশন দেওয়া হবে)
```

> **নিয়ম:** কোডে চ্যানেলের নামের ওপর কোনো লজিক থাকবে না; সবসময় `.env`-এর `CHANNEL_ID` ব্যবহার করা হবে:
>
> ```env
> ATTENDANCE_CHANNEL_ID=123456789012345678
> DAILY_UPDATE_CHANNEL_ID=123456789012345679
> REMINDER_CHANNEL_ID=123456789012345680
> DISCORD_GUILD_ID=123456789012345670
> ```

---

# 6. Phase 2 — Discord Bot Setup & Member Sync

### 6.1. Developer Portal Configuration

1. [Discord Developer Portal](https://discord.com/developers/applications)-এ গিয়ে **New Application** তৈরি করতে হবে।
2. **Bot** ট্যাবে গিয়ে **Add Bot** করতে হবে।
3. **Privileged Gateway Intents** সেকশনে নিচের ইনটেন্টগুলো **ENABLE** করতে হবে:
   - ✅ **Server Members Intent** (`GUILD_MEMBERS`) — ৫,০০০ মেম্বারের লিস্ট সিঙ্ক করার জন্য।
   - ✅ **Message Content Intent** (`MESSAGE_CONTENT`) — `#daily-update` চ্যানেলের মেসেজ রিড করার জন্য।
   - ✅ **Guild Messages Intent** (`GUILD_MESSAGES`) — মেসেজ ইভেন্ট শোনার জন্য।

### 6.2. Guild Member Synchronization (Auto-Sync to DB):

বট চালু হওয়ার সময় সম্পূর্ণ সার্ভারের মেম্বার ডাটাবেসে সিঙ্ক করবে, যাতে ফর্ম থেকে তৎক্ষণাৎ ইউজার ভেরিফাই করা যায়:

```typescript
// Initial Sync on Bot Ready
export async function syncGuildMembers(client: Client, guildId: string) {
  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.fetch();

  for (const [_, member] of members) {
    if (member.user.bot) continue;

    const normalizedUsername = normalizeDiscordUsername(member.user.username);
    await prisma.user.upsert({
      where: { discordUsername: normalizedUsername },
      update: {
        discordUserId: member.id,
        displayName: member.displayName || member.user.username,
        avatarUrl: member.user.displayAvatarURL(),
      },
      create: {
        discordUsername: normalizedUsername,
        discordUserId: member.id,
        displayName: member.displayName || member.user.username,
        avatarUrl: member.user.displayAvatarURL(),
      },
    });
  }
}
```

### 6.3. Real-time Member Event Sync (Join / Leave):

শুধুমাত্র বট চালু হওয়ার সময় সিঙ্ক করলেই যথেষ্ট নয়। বট চালু থাকা অবস্থায় নতুন কেউ সার্ভারে জয়েন করলে বা কেউ সার্ভার ত্যাগ করলে, তৎক্ষণাৎ ডাটাবেসে রিফ্লেক্ট হতে হবে — নাহলে নতুন জয়েন করা ইউজার Attendance ফর্ম সাবমিট করতে পারবে না।

```typescript
// Real-time: New Member Joins
client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;

  const normalizedUsername = normalizeDiscordUsername(member.user.username);
  await prisma.user.upsert({
    where: { discordUsername: normalizedUsername },
    update: {
      discordUserId: member.id,
      displayName: member.displayName || member.user.username,
      avatarUrl: member.user.displayAvatarURL(),
    },
    create: {
      discordUsername: normalizedUsername,
      discordUserId: member.id,
      displayName: member.displayName || member.user.username,
      avatarUrl: member.user.displayAvatarURL(),
    },
  });

  console.log(`[MemberSync] New member synced: ${normalizedUsername}`);
});

// Real-time: Member Leaves / Kicked / Banned
client.on('guildMemberRemove', async (member) => {
  if (member.user.bot) return;

  const normalizedUsername = normalizeDiscordUsername(member.user.username);

  // Soft handling: ইউজারকে ডিলিট না করে শুধু লগ করা হবে,
  // যাতে তার আগের attendance ও daily update হিস্ট্রি সংরক্ষিত থাকে।
  console.log(`[MemberSync] Member left: ${normalizedUsername} (${member.id})`);
});
```

> **ডিজাইন সিদ্ধান্ত:** `guildMemberRemove`-এ ইউজার ডাটাবেস থেকে **ডিলিট করা হবে না**। কারণ তার পূর্ববর্তী Attendance, DailyUpdate ও Reminder হিস্ট্রি রিপোর্টিং ও অডিটের জন্য সংরক্ষিত থাকা দরকার। তবে সে আর Attendance ফর্ম সাবমিট করতে পারবে না, কারণ ভেরিফিকেশনে সার্ভার মেম্বার হিসেবে পাওয়া যাবে না।

---

# 7. Phase 3 — Channel Automation (Open & Lock Schedule)

টাইমজোন: **Asia/Dhaka (UTC+6)**

```text
06:00 PM (Dhaka Time) ──> Bot unlocks #daily-update (SendMessages: TRUE)
                          + Sends "🟢 Channel is OPEN" Embed

11:59 PM     ──> Bot locks #daily-update (SendMessages: FALSE)
                          + Sends "🔴 Channel is CLOSED" Embed
```

### Discord.js Implementation Pattern:

```typescript
import { Client, TextChannel, EmbedBuilder } from 'discord.js';

// Open Channel (06:00 PM)
export async function openDailyUpdateChannel(
  client: Client,
  channelId: string,
) {
  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;

  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: true,
    ViewChannel: true,
  });

  const openEmbed = new EmbedBuilder()
    .setColor(0x00ff00)
    .setTitle('🟢 Daily Update Channel is OPEN')
    .setDescription(
      'Please submit your daily learning updates before **11:59 PM** tonight.',
    )
    .setTimestamp();

  await channel.send({ embeds: [openEmbed] });
}

// Close Channel (11:59 PM)
export async function closeDailyUpdateChannel(
  client: Client,
  channelId: string,
) {
  const channel = (await client.channels.fetch(channelId)) as TextChannel;
  if (!channel) return;

  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: false,
  });

  const closeEmbed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('🔴 Daily Update Channel is CLOSED')
    .setDescription(
      'Submission time is over for today. The channel will reopen at **06:00 PM** tomorrow.',
    )
    .setTimestamp();

  await channel.send({ embeds: [closeEmbed] });
}
```

---

# 8. Phase 4 — Web Attendance Endpoints

### 8.1. Endpoint 1: Verify Discord Username

- **Route:** `GET /api/attendance/verify-user?username=rakib_dev`
- **Logic:**
  1. ইউজারনেম নরমালাইজ করে ডাটাবেসের `users` টেবিলে খোঁজা হবে।
  2. ইউজার আজকের জন্য অলরেডি অ্যাটেনডেন্স দিয়েছে কিনা চেক করা হবে।
- **Response (Found):**
  ```json
  {
    "success": true,
    "verified": true,
    "alreadySubmitted": false,
    "data": {
      "id": "uuid-here",
      "discordUsername": "rakib_dev",
      "displayName": "Rakib Hasan",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  }
  ```

### 8.2. Endpoint 2: Submit Attendance

- **Route:** `POST /api/attendance/submit`
- **Request Body (Zod Validated):**
  ```json
  {
    "name": "Rakib Hasan",
    "phone": "01711000000",
    "email": "rakib@example.com",
    "discordUsername": "rakib_dev"
  }
  ```
- **Logic:**
  1. ইউজারনেম ডিসকর্ড মেম্বার কিনা ভেরিফাই করা হবে।
  2. ইউজারের ফোন ও ইমেইল আপডেট/সেভ করা হবে।
  3. আজকের ঢাকা ডেট (`YYYY-MM-DD`) অনুযায়ী `Attendance` রেকর্ড ইনসার্ট করা হবে।
  4. ইনসার্ট শেষে ডিসকর্ডে লগ বা ইউজারকে কনফার্মেশন রিটার্ন করা হবে।

---

# 9. Phase 5 — Real-time Daily Update Ingestion

Discord বট `messageCreate` ইভেন্ট শুনবে:

```text
User sends message in #daily-update
                 │
                 ▼
        Is it a bot message? ──YES──> Ignore
                 │ NO
                 ▼
      Is it #daily-update? ──NO───> Ignore
                 │ YES
                 ▼
     Normalize message.author.username
                 │
                 ▼
   Upsert User (username + discord_user_id)
                 │
                 ▼
    Save DailyUpdate in PostgreSQL
  (Message Content, Message ID, Date, Time)
                 │
                 ▼
   React with ✅ on the user's message
```

---

# 10. Phase 6 — Database Schema (PostgreSQL + Prisma)

### Complete Schema Design:

```prisma
datasource db {
  provider = "postgresql"
}

generator client {
  provider = "prisma-client-js"
}

// User Model (Synced with Discord Members + Enriched with Form Data)
model User {
  id               String         @id @default(uuid())
  discordUsername  String         @unique @map("discord_username")
  discordUserId    String?        @unique @map("discord_user_id")
  displayName      String?        @map("display_name")
  email            String?        @map("email")
  phone            String?        @map("phone")
  avatarUrl        String?        @map("avatar_url")
  createdAt        DateTime       @default(now()) @map("created_at")
  updatedAt        DateTime       @updatedAt @map("updated_at")

  attendances      Attendance[]
  dailyUpdates     DailyUpdate[]
  reminderRecipients ReminderRecipient[]

  @@index([discordUsername])
  @@index([discordUserId])
  @@map("users")
}

// Attendance Records (Form Submissions)
model Attendance {
  id             String    @id @default(uuid())
  userId         String    @map("user_id")
  name           String    @map("name")
  email          String    @map("email")
  phone          String    @map("phone")
  attendanceDate String    @map("attendance_date") // Format: YYYY-MM-DD in Asia/Dhaka
  status         String    @default("PRESENT")
  submittedAt    DateTime  @default(now()) @map("submitted_at")
  createdAt      DateTime  @default(now()) @map("created_at")

  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, attendanceDate]) // একজন ইউজার একদিনে ১টি attendance
  @@index([attendanceDate])
  @@map("attendances")
}

// Daily Updates Messages (From Discord Channel)
model DailyUpdate {
  id               String    @id @default(uuid())
  userId           String    @map("user_id")
  discordMessageId String    @unique @map("discord_message_id")
  channelId        String    @map("channel_id")
  message          String    @db.Text
  messageDate      String    @map("message_date") // Format: YYYY-MM-DD in Asia/Dhaka
  createdAt        DateTime  @default(now()) @map("created_at")

  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, messageDate])
  @@index([messageDate])
  @@map("daily_updates")
}

// Reminder Broadcast Sessions
model ReminderLog {
  id           String              @id @default(uuid())
  reminderDate String              @map("reminder_date") // YYYY-MM-DD
  message      String              @db.Text
  targetCount  Int                 @map("target_count")
  sentCount    Int                 @default(0) @map("sent_count")
  failedCount  Int                 @default(0) @map("failed_count")
  status       String              @default("PENDING") // PENDING, PROCESSING, COMPLETED, FAILED
  createdById  String?             @map("created_by_id")
  createdAt    DateTime            @default(now()) @map("created_at")

  recipients   ReminderRecipient[]

  @@index([reminderDate])
  @@map("reminder_logs")
}

// Individual Reminder Log
model ReminderRecipient {
  id           String      @id @default(uuid())
  reminderId   String      @map("reminder_id")
  userId       String      @map("user_id")
  status       String      // DELIVERED, DM_CLOSED, FAILED
  errorMessage String?     @map("error_message")
  sentAt       DateTime?   @map("sent_at")

  reminder     ReminderLog @relation(fields: [reminderId], references: [id], onDelete: Cascade)
  user         User        @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([reminderId, status])
  @@map("reminder_recipients")
}
```

---

# 11. Phase 7 — High-Performance Status Aggregation

৫,০০০ ইউজারের স্ট্যাটাস প্রতি লুপে কুয়েরি না করে (N+1 Query এড়াতে), একক SQL / Prisma Aggregation ক্যোয়ারী চালানো হবে:

```sql
-- Single query to calculate today's status for all users
SELECT
    u.id,
    u.discord_username,
    u.discord_user_id,
    u.display_name,
    u.phone,
    u.email,
    CASE WHEN a.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_attendance,
    CASE WHEN du.id IS NOT NULL THEN TRUE ELSE FALSE END AS has_daily_update,
    CASE
        WHEN a.id IS NOT NULL AND du.id IS NOT NULL THEN 'COMPLETE'
        WHEN a.id IS NOT NULL AND du.id IS NULL THEN 'MISSING_UPDATE'
        WHEN a.id IS NULL AND du.id IS NOT NULL THEN 'MISSING_ATTENDANCE'
        ELSE 'MISSING_BOTH'
    END AS status
FROM users u
LEFT JOIN attendances a
    ON u.id = a.user_id AND a.attendance_date = :todayDate
LEFT JOIN (
    SELECT DISTINCT user_id, id
    FROM daily_updates
    WHERE message_date = :todayDate
) du ON u.id = du.user_id;
```

---

# 12. Phase 8 — Safe Bulk DM Reminder System (BullMQ Queue)

### 12.1. The Discord DM Rate-Limit Challenge

২,০০০ ইউজারকে এক সেকেন্ডে DM পাঠাতে গেলে বট ব্যান হবে। তাই **BullMQ + Redis** দিয়ে রেট-লিমিট করা জব কিউ বাস্তবায়ন করা হবে:

- **রেট লিমিট:** প্রতি সেকেন্ডে সর্বোচ্চ **১ থেকে ২টি DM** (~৬০-৮০ DM প্রতি মিনিটে)।
- **২,০০০ ইউজারের জন্য মোট সময়:** প্রায় ২০-২৫ মিনিট।
- **Backoff & Retry:** কোনো কারণে নেটওয়ার্ক ফেইল করলে Exponential Backoff দিয়ে ৩ বার রিট্রাই করবে।

### 12.2. Handling Closed DMs (`Error 50007`) & Fallback Mechanism:

```typescript
async function sendUserDM(botClient: Client, user: User, messageText: string) {
  try {
    if (!user.discordUserId) {
      throw new Error('NO_DISCORD_USER_ID');
    }

    const discordUser = await botClient.users.fetch(user.discordUserId);
    await discordUser.send({
      content: `⚠️ **Daily Update Reminder**\n\n${messageText}`,
    });

    return { success: true, status: 'DELIVERED' };
  } catch (error: any) {
    if (error.code === 50007) {
      // 50007: Cannot send messages to this user (DM is closed)
      return {
        success: false,
        status: 'DM_CLOSED',
        error: 'User has DMs disabled',
      };
    }
    return { success: false, status: 'FAILED', error: error.message };
  }
}
```

### 12.3. Fallback Announcement for Closed DMs:

রিমাইন্ডার কিউ শেষ হওয়ার পর যেসকল ইউজারের স্ট্যাটাস `DM_CLOSED`, তাদের আইডি নিয়ে `#daily-update-reminder` চ্যানেলে ব্যাচ মেনশন দিয়ে মেসেজ পাঠিয়ে দেওয়া হবে:

```text
📢 Attention: The following users have DMs closed. Please submit your daily update ASAP!
<@123456789012345678> <@234567890123456789> ...
```

---

# 13. Phase 9 — Admin Dashboard Features

### 13.1. Overview Metrics (Cards):

- **Total Users:** ৫,০০০
- **Attendance Submitted:** ৪,৩২০ (৮৬.৪%)
- **Daily Update Submitted:** ৩,০০০ (৬০.০%)
- **Both Completed:** ২,৮০০ (৫৬.০%)
- **Missing Update Only:** ১,৫২০
- **Missing Both:** ৬৮০

### 13.2. Live Broadcast Progress Bar (via Server-Sent Events / SSE):

অ্যাডমিন যখন **[Send Reminder]** বাটনে চাপ দেবেন, ড্যাশবোর্ডে লাইভ প্রগ্রেস বার আপডেট হবে:

```text
Sending Reminders...
[████████████████████░░░░░░░░░░] 64% (1,280 / 2,000)
Delivered: 1,210 | DM Closed: 65 | Failed: 5
```

### 13.3. Advanced Filter, Search & Export:

- **Date Selector:** যেকোনো পূর্ববর্তী দিনের হিস্ট্রি দেখার সুবিধা।
- **Status Filter:** `All`, `Complete`, `Missing Update`, `Missing Attendance`, `Missing Both`.
- **Search Bar:** নাম, ফোন নম্বর, ইমেইল অথবা ইউজারনেম দিয়ে তাৎক্ষণিক ফিল্টার।
- **Export Button:** ফিল্টার করা ডাটা এক ক্লিকে **CSV / Excel** ফাইলে ডাউনলোড।
- **User Detail Modal:** নির্দিষ্ট ইউজারে ক্লিক করলে তার নাম, ফোন, ইমেইল, সম্পূর্ণ অ্যাটেনডেন্স টাইম ও দিনের সব ডিসকর্ড মেসেজগুলো টাইমস্ট্যাম্পসহ দেখা যাবে।

---

# 14. Daily Automated Operational Timeline

```text
06:00 PM (Dhaka)
    │
    ├──> #daily-update চ্যানেল UNLOCK হবে
    └──> ঘোষণা দেওয়া হবে: "🟢 Channel is now open"

06:00 PM — 11:59 PM
    │
    ├──> স্টুডেন্টরা Web Form-এ attendance দিচ্ছে ──> Instant Verified & Saved to DB
    └──> স্টুডেন্টরা #daily-update-এ মেসেজ দিচ্ছে ─> Bot real-time DB-তে save করছে

11:59 PM
    │
    └──> শেষ মেসেজগুলো ইনজেস্ট হচ্ছে

12:00 AM Midnight
    │
    ├──> #daily-update চ্যানেল LOCK হবে (SendMessages: FALSE)
    ├──> ঘোষণা দেওয়া হবে: "🔴 Channel is now closed"
    └──> আজকের দিনের ফাইনাল স্ট্যাটাস ক্যালকুলেট হবে

12:05 AM
    │
    ├──> Admin ড্যাশবোর্ডে গিয়ে Missing Users লিস্ট দেখবে
    ├──> Custom Reminder লিখে [Send Reminder] বাটনে ক্লিক করবে
    ├──> BullMQ Queue রেট লিমিট বজায় রেখে DM পাঠানো শুরু করবে
    └──> DM বন্ধ থাকা ইউজারদের জন্য #daily-update-reminder চ্যানেলে ফলব্যাক পোস্ট হবে
```

---

# 15. Step-by-Step Implementation Roadmap

```text
Phase 1: Discord Bot Core & Member Sync
├── [x] Discord Developer Application Creation (Bot Added to Server)
├── [x] Privileged Gateway Intents (Members & Message Content)
├── [x] Discord Bot Token & Channel IDs Setup in .env
├── [x] Bot client initialization, ready event & initial guild.members.fetch() sync into DB
├── [x] Real-time member sync: guildMemberAdd → auto upsert, guildMemberRemove → log only

Phase 2: Database & Prisma Architecture
├── [x] PostgreSQL Database setup (Docker / Cloud)
├── [x] Complete Prisma Schema migration (User, Attendance, DailyUpdate, ReminderLog)
├── [x] Efficient Indexes & Repository helper queries

Phase 3: Web Attendance Endpoints & Live Verification
├── [x] GET /api/attendance/verify-user?username=... (Server membership & duplicate check)
├── [x] POST /api/attendance/submit (Validate Name, Phone, Email, Discord Username & Insert)
├── [x] Per-IP rate limiting on both public endpoints + CORS origin allowlist
├── [ ] Next.js / React Attendance Form with Live Verified Badge  (frontend repo, not this one)

Phase 4: Real-time Daily Update Collection
├── [x] messageCreate listener for #daily-update
├── [x] Snowflake-based author resolution & real-time message insert
├── [x] Success reaction emoji (✅) on message

Phase 5: Automated Scheduler (Asia/Dhaka)
├── [x] 06:00 PM Cron: Unlock channel & send opening embed
├── [x] 11:59 PM Cron: Lock channel & send closing embed
├── [x] Admin-managed schedule: times, weekdays & on/off stored in DB, edited from
│       the dashboard (GET/PATCH /api/schedule/daily-update). 06:00 PM / 11:59 PM
│       are only the DEFAULTS — they are no longer hard-coded, so an exam week or
│       a holiday needs no deploy.
├── [x] Boot reconcile: a restart mid-window restores the correct channel state
│       (silently — no announcement, or a crash-loop would spam the channel)
├── [x] Manual override: POST /api/schedule/daily-update/open | /lock

Phase 6: BullMQ Queue & Rate-Limited DM Reminders
├── [ ] Redis setup & BullMQ Queue configuration
├── [ ] Rate limiter (1-2 DMs per second)
├── [ ] Closed DMs (Error 50007) error handling & fallback channel mention

Phase 7: Admin Dashboard (Frontend & API)
├── [ ] JWT-authenticated API endpoints for metrics & user lists
├── [ ] Next.js UI with real-time SSE progress tracking
├── [ ] Filter, Pagination, User Detail View & CSV/Excel export
```

---

# 16. Golden Engineering Rules

1. **Snowflake User ID for DMs:** DM পাঠানোর জন্য সবসময় `discord_user_id` ব্যবহার করতে হবে।
2. **Strict Official Username Rules:** ইউজারনেম মেলানোর আগে সবসময় ডিসকর্ডের অফিসিয়াল স্ট্যান্ডার্ড রেজেক্স (`/^(?!.*\.{2})[a-z0-9_.]{2,32}$/`) মেনে ভ্যালিডেট ও লোয়ারকেস নরমালাইজ করতে হবে। ভ্যালিডেশন কখনোই বৈধ মেম্বারকে ব্লক করার মতো কড়া হবে না — শুরু/শেষে `_` বা `.` অনুমোদিত (দেখুন §3.2)।
3. **Strict Form Verification:** ফর্মে টাইপ করা ইউজারনেম সার্ভার মেম্বার লিস্টে না থাকলে কোনোভাবেই ফর্ম সাবমিট করতে দেওয়া হবে না।
4. **Never Burst DMs:** কখনোই লুপের মধ্যে সরাসরি হাজার হাজার DM ফায়ার করা যাবে না; সবসময় BullMQ Queue রেট লিমিট দিয়ে প্রসেস করতে হবে।
5. **Timezone Uniformity:** ডেট ক্যালকুলেশনে সবসময় `Asia/Dhaka` টাইমজোন স্ট্যান্ডার্ড হিসেবে বজায় রাখতে হবে।
6. **Instant Ingestion:** মেসেজ এবং ফর্ম সাবমিশন কখনো রাতের জন্য জমিয়ে রাখা যাবে না; আসার সাথে সাথেই ডাটাবেসে সেভ করতে হবে।
7. **Idempotency & Unique Constraints:** `discord_message_id` এবং `(user_id, attendance_date)` ইউনিক রেখে ডুপ্লিকেট এন্ট্রি প্রতিরোধ করতে হবে।
