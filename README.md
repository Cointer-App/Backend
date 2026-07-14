<div align="center">

<img src="https://github.com/Cointer-App/.github/blob/main/logo.svg" width="80" height="80" alt="Cointer Logo" />

<h1>Cointer Backend</h1>

<p>API that watches crypto addresses and sends a notification when they get money</p>

</div>

<br />

## Overview

This is the backend for Cointer. It watches Bitcoin and Ethereum addresses on the blockchain. When a watched address gets a deposit, it sends a notification through the channels you set up. There are no accounts or passwords. You get a single personal key, and everything you add is tied to that key.

<br />

## Features

<table>
<tr>
<td width="50%" valign="top">

**Personal Key Login:**
No email or password. You get a key when you sign up. Use it to log in on any device. You can rotate it or delete your account at any time.

</td>
<td width="50%" valign="top">

**Watch Bitcoin and Ethereum Addresses:**
Add up to 10 addresses per key. Supports Bitcoin and Ethereum, including tokens like USDC, USDT, and DAI. Old transactions are skipped so you only get notified about new deposits.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**On-Chain Watchers:**
Checks Bitcoin every 30 seconds and Ethereum every 15 seconds for new deposits to your saved addresses.

</td>
<td width="50%" valign="top">

**Notification Channels:**
Send alerts through ntfy, Discord, Slack, or email. You can test any channel before relying on it.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Mute Per Address:**
Turn off notifications for a single address without turning off the whole channel.

</td>
<td width="50%" valign="top">

**Push Notifications:**
Register a device to get native push alerts through the Cointer mobile app.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Activity Feed:**
See a full history of deposits, priced in your currency. Includes daily, weekly, and monthly totals.

</td>
<td width="50%" valign="top">

**Rate Limiting:**
Limits are in place per IP and per key to keep the service stable for everyone.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Public Info Endpoints:**
Check supported chains, service status, and overall stats without logging in.

</td>
<td width="50%" valign="top">

**Database Encryption:**
Personal keys are hashed and never stored in plain text. Channel secrets are only ever shown as masked previews.

</td>
</tr>
</table>

<br />

## Donate

Cointer is free, with no ads or paid tier. Donations pay for the servers, and the more that comes in, the more chains we can support. Addresses and QR codes are at [cointer.app/donate](https://cointer.app/donate).
