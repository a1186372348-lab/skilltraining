import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";

import type { SmtpConfig } from "./config";

/**
 * 邮件投递抽象（T03 范围：仅投递魔法链接）。
 * - 开发默认 ConsoleMailer：链接输出到服务端控制台，复制到浏览器即可登录；
 * - 配置 SMTP_HOST 后切换 SmtpMailer 真实发信（零依赖极简 SMTP 客户端，
 *   支持 AUTH LOGIN 与隐式 TLS；如需 STARTTLS/复杂鉴权，后续再引入 nodemailer）。
 */

export interface Mailer {
  /** 投递魔法链接；失败必须抛错（由调用方记录日志并统一对外响应） */
  sendMagicLink(to: string, link: string): Promise<void>;
}

/** 开发环境投递：打印到服务端控制台 */
export class ConsoleMailer implements Mailer {
  async sendMagicLink(to: string, link: string): Promise<void> {
    console.info(
      `[auth] 魔法链接（开发环境控制台投递）\n  收件人: ${to}\n  登录链接: ${link}\n  （15 分钟内有效，仅可使用一次）`,
    );
  }
}

const SMTP_TIMEOUT_MS = 10_000;

/** 极简 SMTP 客户端：EHLO → AUTH LOGIN（可选）→ MAIL/RCPT/DATA → QUIT */
export class SmtpMailer implements Mailer {
  constructor(private readonly smtp: Required<Pick<SmtpConfig, "host" | "port" | "secure" | "from">> & SmtpConfig & { host: string }) {}

  async sendMagicLink(to: string, link: string): Promise<void> {
    const subject = "你的登录链接（15 分钟内有效）";
    const body = [
      "你好：",
      "",
      "点击以下链接完成登录（15 分钟内有效，仅可使用一次）：",
      link,
      "",
      "如果这不是你的操作，请忽略本邮件。",
    ].join("\r\n");
    await this.send(to, subject, body);
  }

  private async send(to: string, subject: string, body: string): Promise<void> {
    const socket = await this.openSocket();
    try {
      const dialog = new SmtpDialog(socket);
      await dialog.expect(220); // 服务端问候
      await dialog.command("EHLO localhost", 250);
      if (this.smtp.user && this.smtp.pass) {
        await dialog.command("AUTH LOGIN", 334);
        await dialog.command(Buffer.from(this.smtp.user).toString("base64"), 334);
        await dialog.command(Buffer.from(this.smtp.pass).toString("base64"), 235);
      }
      await dialog.command(`MAIL FROM:<${this.smtp.from}>`, 250);
      await dialog.command(`RCPT TO:<${to}>`, 250);
      await dialog.command("DATA", 354);
      const message = buildMessage({ from: this.smtp.from, to, subject, body });
      await dialog.command(`${message}\r\n.`, 250);
      await dialog.command("QUIT", 221);
    } finally {
      socket.destroy();
    }
  }

  private openSocket(): Promise<Socket | TLSSocket> {
    const { host, port, secure } = this.smtp;
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      if (secure) {
        const socket = tlsConnect({ host, port, servername: host }, () => resolve(socket));
        socket.once("error", onError);
      } else {
        const socket = netConnect({ host, port }, () => resolve(socket));
        socket.once("error", onError);
      }
    });
  }
}

/** SMTP 逐行应答对话 */
class SmtpDialog {
  private buffer = "";

  constructor(private readonly socket: Socket | TLSSocket) {
    socket.setTimeout(SMTP_TIMEOUT_MS, () => {
      socket.destroy(new Error("SMTP 应答超时"));
    });
  }

  async command(line: string, expectCode: number): Promise<void> {
    this.socket.write(`${line}\r\n`);
    await this.expect(expectCode);
  }

  /** 等待服务端应答；支持多行应答（"250-..." 续行，"250 " 结束） */
  expect(code: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        const lines = this.buffer.split("\r\n");
        // 末尾元素为未完成残行；此前均为完整行
        const completeLines = lines.slice(0, -1);
        const finalLine = completeLines[completeLines.length - 1];
        if (!finalLine || !/^\d{3} /.test(finalLine)) return; // 多行应答未结束
        cleanup();
        const received = Number.parseInt(finalLine.slice(0, 3), 10);
        if (received === code) resolve();
        else reject(new Error(`SMTP 期望 ${code}，收到：${finalLine}`));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.buffer = "";
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
    });
  }
}

function buildMessage(input: { from: string; to: string; subject: string; body: string }): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    // UTF-8 主题按 RFC 2047 编码
    `Subject: =?UTF-8?B?${Buffer.from(input.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  // 点号转义（dot-stuffing），防止正文行被误认为结束符
  const safeBody = input.body.replace(/^\./gm, "..");
  return `${headers.join("\r\n")}\r\n\r\n${safeBody}`;
}

/** 按环境配置创建投递器：有 SMTP_HOST 走真实发信，否则控制台输出 */
export function createMailer(smtp: SmtpConfig): Mailer {
  if (smtp.host) {
    return new SmtpMailer({ ...smtp, host: smtp.host });
  }
  return new ConsoleMailer();
}
