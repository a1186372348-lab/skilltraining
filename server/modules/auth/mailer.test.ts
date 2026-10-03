import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleMailer, SmtpMailer, createMailer } from "./mailer";

/** 假 SMTP 服务器：按 AUTH LOGIN 流程应答，并记录收到的命令与邮件正文 */
class FakeSmtpServer {
  received: string[] = [];
  mailData = "";
  authUser: string | null = null;
  authPass: string | null = null;
  rejectAuth = false;
  private server: Server | null = null;
  private collectingData = false;

  async start(): Promise<number> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private handle(socket: Socket): void {
    socket.write("220 fake-smtp ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\r\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        this.onLine(socket, line);
        idx = buffer.indexOf("\r\n");
      }
    });
  }

  private onLine(socket: Socket, line: string): void {
    if (this.collectingData) {
      if (line === ".") {
        this.collectingData = false;
        socket.write("250 queued\r\n");
      } else {
        this.mailData += `${line}\n`;
      }
      return;
    }
    this.received.push(line);
    const upper = line.toUpperCase();
    if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
      socket.write("250-fake\r\n250 AUTH LOGIN\r\n");
    } else if (upper === "AUTH LOGIN") {
      socket.write("334 VXNlcm5hbWU6\r\n");
    } else if (this.authUser === null && this.received.includes("AUTH LOGIN")) {
      this.authUser = Buffer.from(line, "base64").toString("utf8");
      socket.write("334 UGFzc3dvcmQ6\r\n");
    } else if (this.authPass === null && this.authUser !== null) {
      this.authPass = Buffer.from(line, "base64").toString("utf8");
      socket.write(this.rejectAuth ? "535 auth failed\r\n" : "235 ok\r\n");
    } else if (upper.startsWith("MAIL FROM")) {
      socket.write("250 ok\r\n");
    } else if (upper.startsWith("RCPT TO")) {
      socket.write("250 ok\r\n");
    } else if (upper === "DATA") {
      this.collectingData = true;
      socket.write("354 go ahead\r\n");
    } else if (upper === "QUIT") {
      socket.write("221 bye\r\n");
    }
  }
}

describe("ConsoleMailer（开发环境默认投递）", () => {
  it("将登录链接输出到服务端控制台", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const mailer = new ConsoleMailer();

    await mailer.sendMagicLink("pm@example.com", "http://localhost:3000/api/auth/verify?token=abc");

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain("pm@example.com");
    expect(output).toContain("http://localhost:3000/api/auth/verify?token=abc");
    spy.mockRestore();
  });
});

describe("SmtpMailer（配置 SMTP 环境变量后真实发信）", () => {
  let fake: FakeSmtpServer;
  let port: number;

  beforeEach(async () => {
    fake = new FakeSmtpServer();
    port = await fake.start();
  });

  afterEach(async () => {
    await fake.stop();
  });

  it("完成 AUTH LOGIN 并投递含链接的邮件", async () => {
    const mailer = new SmtpMailer({
      host: "127.0.0.1",
      port,
      secure: false,
      user: "smtp-user",
      pass: "smtp-pass",
      from: "noreply@example.com",
    });

    await mailer.sendMagicLink("pm@example.com", "http://localhost:3000/api/auth/verify?token=xyz");

    expect(fake.authUser).toBe("smtp-user");
    expect(fake.authPass).toBe("smtp-pass");
    expect(fake.received).toContain("MAIL FROM:<noreply@example.com>");
    expect(fake.received).toContain("RCPT TO:<pm@example.com>");
    expect(fake.mailData).toContain("To: pm@example.com");
    expect(fake.mailData).toContain("http://localhost:3000/api/auth/verify?token=xyz");
  });

  it("未配置账号密码时跳过 AUTH，直接投递", async () => {
    const mailer = new SmtpMailer({
      host: "127.0.0.1",
      port,
      secure: false,
      from: "noreply@example.com",
    });

    await mailer.sendMagicLink("pm@example.com", "http://localhost:3000/api/auth/verify?token=no-auth");

    expect(fake.received.some((l) => l.startsWith("AUTH"))).toBe(false);
    expect(fake.mailData).toContain("token=no-auth");
  });

  it("SMTP 鉴权失败时抛错（由上层记录并统一对外响应）", async () => {
    fake.rejectAuth = true;
    const mailer = new SmtpMailer({
      host: "127.0.0.1",
      port,
      secure: false,
      user: "bad",
      pass: "bad",
      from: "noreply@example.com",
    });

    await expect(mailer.sendMagicLink("pm@example.com", "http://x/y?token=z")).rejects.toThrow(/535/);
  });
});

describe("createMailer（按环境配置选择投递器）", () => {
  it("无 SMTP_HOST 时返回 ConsoleMailer", () => {
    expect(
      createMailer({ port: 465, secure: true, from: "noreply@localhost" }),
    ).toBeInstanceOf(ConsoleMailer);
  });

  it("有 SMTP_HOST 时返回 SmtpMailer", () => {
    expect(
      createMailer({ host: "smtp.example.com", port: 465, secure: true, from: "a@b.c" }),
    ).toBeInstanceOf(SmtpMailer);
  });
});
