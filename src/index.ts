import { Browser, Page, Viewport, Response } from "puppeteer";
import { QualwebOptions, SourceHtml, PageOptions } from "@qualweb/core";
import { PageData } from "@qualweb/dom";
import fetch from "node-fetch";
import DomHandler, { Node } from "domhandler";
import { Parser } from "htmlparser2";

import {
  DEFAULT_DESKTOP_USER_AGENT,
  DEFAULT_MOBILE_USER_AGENT,
  DEFAULT_DESKTOP_PAGE_VIEWPORT_WIDTH,
  DEFAULT_DESKTOP_PAGE_VIEWPORT_HEIGHT,
  DEFAULT_MOBILE_PAGE_VIEWPORT_WIDTH,
  DEFAULT_MOBILE_PAGE_VIEWPORT_HEIGHT,
} from "./constants";
import { HTMLValidationReport } from "@qualweb/html-validator";

class Dom {
  private page!: Page;
  private endpoint: string;

  constructor() {
    this.endpoint = "http://194.117.20.242/validate/";
  }

  public async getDOM(
    browser: Browser,
    options: QualwebOptions,
    url: string,
    html: string
  ): Promise<PageData> {
    if (options.validator) {
      this.endpoint = options.validator;
    }

    this.page = await browser.newPage();
    await this.page.setBypassCSP(true);
    await this.setPageViewport(options.viewport);

    const needsValidator = this.validatorNeeded(options);
    const needsPreprocessedHTML = this.sourceHTMLNeeded(options);

    let validation: HTMLValidationReport | undefined = undefined;
    let response: Response | null;
    let _sourceHtml = "";

    if (url) {
      if (needsValidator && needsPreprocessedHTML) {
        [response, validation, _sourceHtml] = await Promise.all([
          this.navigateToPage(url),
          this.getValidatorResult(url),
          this.getSourceHtml(url),
        ]);
      } else if (needsValidator) {
        [response, validation] = await Promise.all([
          this.navigateToPage(url),
          this.getValidatorResult(url),
        ]);
      } else if (needsPreprocessedHTML) {
        [response, _sourceHtml] = await Promise.all([
          this.navigateToPage(url),
          this.getSourceHtml(url),
        ]);
      } else {
        response = await this.navigateToPage(url);
      }

      const sourceHTMLPuppeteer = await response?.text();

      if (!this.isHtmlDocument(sourceHTMLPuppeteer, url)) {
        await this.page.close();
        this.page = await browser.newPage();
        await this.page.setContent(
          "<!DOCTYPE html><html nonHTMLPage=true><body></body></html>",
          {
            timeout: 1000 * 60 * 2,
          }
        );
      }
    } else {
      await this.page.setContent(html, {
        timeout: 1000 * 60 * 2,
      });
      _sourceHtml = await this.page.content();

      if (!this.isHtmlDocument(_sourceHtml)) {
        await this.page.close();
        this.page = await browser.newPage();
        await this.page.setContent(
          "<!DOCTYPE html><html nonHTMLPage=true><body></body></html>",
          {
            timeout: 1000 * 60 * 2,
          }
        );
      }
    }

    const sourceHtml = this.parseSourceHTML(_sourceHtml);
    return { sourceHtml, page: this.page, validation };
  }

  public async close(): Promise<void> {
    await this.page.close();
  }

  public async navigateToPage(url: string): Promise<Response | null> {
    return this.page.goto(url, {
      timeout: 1000 * 60 * 3,
      waitUntil: ["load"],
    });
  }

  private async setPageViewport(options?: PageOptions): Promise<void> {
    if (options) {
      if (options.userAgent) {
        await this.page.setUserAgent(options.userAgent);
      } else if (options.mobile) {
        await this.page.setUserAgent(DEFAULT_MOBILE_USER_AGENT);
      } else {
        await this.page.setUserAgent(DEFAULT_DESKTOP_USER_AGENT);
      }

      const viewPort: Viewport = {
        width: options.mobile
          ? DEFAULT_MOBILE_PAGE_VIEWPORT_WIDTH
          : DEFAULT_DESKTOP_PAGE_VIEWPORT_WIDTH,
        height: options.mobile
          ? DEFAULT_MOBILE_PAGE_VIEWPORT_HEIGHT
          : DEFAULT_DESKTOP_PAGE_VIEWPORT_HEIGHT,
      };

      if (options.resolution?.width) {
        viewPort.width = options.resolution.width;
      }
      if (options.resolution?.height) {
        viewPort.height = options.resolution.height;
      }

      viewPort.isMobile = !!options.mobile;
      viewPort.isLandscape =
        options.landscape !== undefined
          ? options.landscape
          : viewPort.width > viewPort.height;
      viewPort.hasTouch = !!options.mobile;

      await this.page.setViewport(viewPort);
    } else {
      await this.page.setViewport({
        width: DEFAULT_DESKTOP_PAGE_VIEWPORT_WIDTH,
        height: DEFAULT_DESKTOP_PAGE_VIEWPORT_HEIGHT,
        isMobile: false,
        hasTouch: false,
        isLandscape: true,
      });
    }
  }

  private async getSourceHtml(url: string, options?: any): Promise<string> {
    try {
      const fetchOptions = {
        headers: {
          "User-Agent": options
            ? options.userAgent
              ? options.userAgent
              : options.mobile
              ? DEFAULT_MOBILE_USER_AGENT
              : DEFAULT_DESKTOP_USER_AGENT
            : DEFAULT_DESKTOP_USER_AGENT,
        },
      };
      const response = await fetch(url, fetchOptions);
      return (await response.text()).trim();
    } catch (e) {
      return "";
    }
  }

  private parseSourceHTML(html: string): SourceHtml {
    const sourceHTML = html.trim();
    const parsedHTML = this.parseHTML(sourceHTML);
    const source = {
      html: {
        plain: sourceHTML,
        parsed: parsedHTML,
      },
    };

    return source;
  }

  private parseHTML(html: string): Node[] {
    const handler = new DomHandler(() => {}, {
      withStartIndices: true,
      withEndIndices: true,
    });
    const parser = new Parser(handler);
    parser.write(html.replace(/(\r\n|\n|\r|\t)/gm, ""));
    parser.end();

    return handler.dom;
  }

  private getValidatorResult(
    url: string
  ): Promise<HTMLValidationReport | undefined> {
    const validationUrl = this.endpoint + encodeURIComponent(url);
    return new Promise((resolve) => {
      try {
        fetch(validationUrl, { timeout: 20000 }).then((response) => {
          if (response && response.status === 200) {
            response.json().then((response) => {
              try {
                const validation = <HTMLValidationReport>JSON.parse(response);
                resolve(validation);
              } catch (e) {
                resolve(undefined);
              }
            });
          }
        });
      } catch (e) {
        resolve(undefined);
      }
    });
  }

  private validatorNeeded(options: QualwebOptions): boolean {
    /*const checkModule = !options.execute || !!options.execute.wcag;

    const checkRules =
      !options["wcag-techniques"] ||
      !!(
        options["wcag-techniques"].techniques &&
        (options["wcag-techniques"].techniques.includes("QW-WCAG-T16") ||
          options["wcag-techniques"].techniques.includes("H88"))
      );

    const checkExclusions =
      !options["wcag-techniques"] ||
      !!(
        options["wcag-techniques"].exclude &&
        (options["wcag-techniques"].exclude.includes("QW-WCAG-T16") ||
          options["wcag-techniques"].exclude.includes("H88"))
      );

    return checkModule || checkRules || !checkExclusions;*/

    if (options.execute) {
      if (!!options.execute.wcag) {
        if (options["wcag-techniques"]) {
          if (options["wcag-techniques"].exclude) {
            if (
              options["wcag-techniques"].exclude.includes("QW-WCAG-T16") ||
              options["wcag-techniques"].exclude.includes("H88")
            ) {
              return false;
            } else if (options["wcag-techniques"].techniques) {
              if (
                options["wcag-techniques"].techniques.includes("QW-WCAG-T16") ||
                options["wcag-techniques"].techniques.includes("H88")
              ) {
                return true;
              } else {
                return false;
              }
            } else {
              return true;
            }
          } else if (options["wcag-techniques"].techniques) {
            if (
              options["wcag-techniques"].techniques.includes("QW-WCAG-T16") ||
              options["wcag-techniques"].techniques.includes("H88")
            ) {
              return true;
            } else {
              return false;
            }
          } else {
            return true;
          }
        } else {
          return true;
        }
      } else {
        return false;
      }
    } else {
      return true;
    }
  }

  private sourceHTMLNeeded(options: QualwebOptions): boolean {
    /*const checkModule =
      (!!options && !options.execute) ||
      (!!options.execute && !!options.execute.act);
    const checkRules =
      !!options["act-rules"] &&
      !!options["act-rules"].rules &&
      (options["act-rules"].rules.includes("QW-ACT-R4") ||
        options["act-rules"].rules.includes("bc659a"));
    return checkModule || checkRules;*/

    if (options.execute) {
      if (!!options.execute.act) {
        if (options["act-rules"]) {
          if (options["act-rules"].exclude) {
            if (
              options["act-rules"].exclude.includes("QW-ACT-R4") ||
              options["act-rules"].exclude.includes("bc659a")
            ) {
              return false;
            } else if (options["act-rules"].rules) {
              if (
                options["act-rules"].rules.includes("QW-ACT-R4") ||
                options["act-rules"].rules.includes("bc659a")
              ) {
                return true;
              } else {
                return false;
              }
            } else {
              return true;
            }
          } else if (options["act-rules"].rules) {
            if (
              options["act-rules"].rules.includes("QW-ACT-R4") ||
              options["act-rules"].rules.includes("bc659a")
            ) {
              return true;
            } else {
              return false;
            }
          } else {
            return true;
          }
        } else {
          return true;
        }
      } else {
        return false;
      }
    } else {
      return true;
    }
  }

  private isHtmlDocument(content?: string, url?: string): boolean {
    if (
      url &&
      (url.endsWith(".svg") || url.endsWith(".xml") || url.endsWith(".xhtml"))
    ) {
      return false;
    }

    return !(
      (content?.trim().startsWith("<math") ||
        content?.trim().startsWith("<svg")) &&
      !content?.includes("<html")
    );
  }
}

export { Dom };
