import crypto from 'crypto';
import net from 'net';
import winston from 'winston';

import errorCodes from './errorCodes.json';
import { Types } from './requestTypes';

interface ConstructorOptions {
  host?: string;
  port?: number;
  IAID?: number;
  IAName?: string;
  IADescription?: string;
  username?: string;
  password?: string;
}

interface RequestOptions {
  req: string;
  options?: any;
  json?: boolean;
}

interface Error {
  code: number;
  message: string;
}

export = class Fishbowl {
  private errorCodes: any;
  private loggedIn = false;
  private key = '';
  private userId = '';

  private connection: net.Socket;
  private connected = false;
  private waiting = true;
  private reqQueue: any[] = [];

  private host: string;
  private port: number;
  private IAID: number;
  private IAName: string;
  private IADescription: string;

  private username: string;
  private password: string;

  private logger: any;

  /**
   * This will set default values then setup a connection with Fishbowl and send a login request
   * @param host - Fishbowl Server Host location
   * @param port - Fishbowl Server Port
   * @param IADescription
   * @param IAID
   * @param IAName - Display name of Integrated App in Fishbowl
   * @param username - Fishbowl username
   * @param password - Fishbowl password
   */
  constructor({ host = '127.0.0.1', port = 28192, IAID = 54321, IAName = 'Fishbowljs', IADescription = 'Fishbowljs helper', username = 'admin', password = 'admin' }: ConstructorOptions) {
    this.host = host;
    this.port = port;
    this.IAID = IAID;
    this.IAName = IAName;
    this.IADescription = IADescription;
    this.username = username;
    this.password = password;
    this.connection = new net.Socket();
    this.errorCodes = errorCodes;

    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [
        new winston.transports.File({
          filename: 'fishbowl-js.log',
          format: winston.format.combine(
            winston.format.timestamp({
              format: 'YYYY-MM-DD hh:mm:ss A ZZ'
            }),
            winston.format.json()
          )
        })
      ]
    });

    this.connectToFishbowl(false);
  }

  /**
   * @param {RequestOptions} - holds the request type, options for that request, and whether you want the info in JSON or CSV
   * @param cb - (err: Error | null, res: JSON)
   */
  public sendRequest = ({ req, options, json = true }: RequestOptions, cb?: (err: Error | null, res: any) => void): void => {
    if (req === 'LoginRq' && this.loggedIn) {
      return;
    }

    if (req === 'LogoutRq') {
      this.loggedIn = false;
    }

    if (this.waiting) {
      this.reqQueue.push({ req, options, json, cb });
      return;
    }

    let reqToFishbowl = '';
    switch (req) {
      case 'LoginRq': {
        reqToFishbowl = this.loginRequest();
        break;
      }
      case 'LogoutRq': {
        reqToFishbowl = this.logoutRequest();
        break;
      }
      case 'ExecuteQueryRq': {
        reqToFishbowl = this.executeQueryRq(options);
        break;
      }
      case 'ImportRq': {
        reqToFishbowl = this.importRq(options);
        break;
      }
      case 'ImportHeaderRq': {
        reqToFishbowl = this.importHeaderRq(options);
        break;
      }
      case 'IssueSORq': {
        reqToFishbowl = this.issueSoRq(options);
        break;
      }
      case 'QuickShipRq': {
        reqToFishbowl = this.quickShipRq(options);
        break;
      }
      case 'VoidSORq': {
        reqToFishbowl = this.voidSoRq(options);
        break;
      }
      default: {
        reqToFishbowl = this.customRq(req, options);
      }
    }

    this.waiting = true;
    if (!this.connected) {
      this.logger.info('Not connected to server, connecting now...');
      this.reqQueue.push({ req, options, json, cb });
      this.connectToFishbowl(true);
      return;
    }

    this.connection.once('done', (err, data) => {
      if (err && cb !== undefined) {
        return cb(err, null);
      }

      if (err) {
        this.logger.error(err);
        return;
      }

      const fbData = Object.keys(data.FbiJson.FbiMsgsRs)[1];
      if (data.FbiJson.FbiMsgsRs.statusCode !== 1000) {
        const fbError: Error = {
          code: data.FbiJson.FbiMsgsRs.statusCode,
          message: data.FbiJson.FbiMsgsRs.statusMessage || this.errorCodes[data.FbiJson.FbiMsgsRs.statusCode]
        };
        this.logger.error(fbError);
        if (cb !== undefined) {
          cb(fbError, null);
        }
      } else if (data.FbiJson.FbiMsgsRs[fbData].statusCode !== 1000) {
        const fbError: Error = {
          code: data.FbiJson.FbiMsgsRs[fbData].statusCode,
          message: data.FbiJson.FbiMsgsRs[fbData].statusMessage || this.errorCodes[data.FbiJson.FbiMsgsRs[fbData].statusCode]
        };
        this.logger.error(fbError);
        if (cb !== undefined) {
          cb(fbError, null);
        }
      } else {
        if (fbData === 'LoginRs') {
          this.loggedIn = true;
          this.key = data.FbiJson.Ticket.Key;
          this.userId = data.FbiJson.Ticket.UserID;
        } else if (fbData === 'ExecuteQueryRs' && json) {
          data = this.parseExecuteQueryRqToJson(data);
        } else if (fbData === 'ImportHeaderRs' && json) {
          data = this.parseImportHeaderRqToJson(data);
        }

        if (cb !== undefined) {
          cb(null, data.FbiJson.FbiMsgsRs[fbData]);
        }
      }

      this.deque();
    });

    const reqLength = Buffer.alloc(4);
    reqLength.writeIntBE(Buffer.byteLength(reqToFishbowl, 'utf8'), 0, 4);
    this.connection.write(reqLength);
    this.connection.write(reqToFishbowl);
  };

  /**
   * Setup connection with Fishbowl
   */
  private connectToFishbowl = (login: boolean): void => {
    let resLength: number | undefined;
    let resData: any;

    this.connection.connect(this.port, this.host, () => {
      this.connected = true;
      this.logger.info('Connected to Fishbowl...');
      if (login) {
        this.waiting = false;
        this.loginToFishbowl();
      }
      this.deque();
    });

    this.connection.on('close', () => {
      this.logger.info('Disconnected from Fishbowl');
      this.connected = false;
    });

    this.connection.on('error', err => {
      this.logger.error(`Unexpected error... Disconnected from server, attempting to reconnect. ${err}`);
      this.connected = false;
      this.loggedIn = false;
      this.connectToFishbowl(true);
    });

    this.connection.on('data', data => {
      if (resLength === undefined) {
        resLength = data.readInt32BE(0);
        resData = data.slice(4);
      } else {
        resData = Buffer.concat([resData, data]);
      }

      if (resData.length === resLength) {
        const resJson = JSON.parse(resData.toString('utf8'));
        resLength = undefined;

        // Inactivity check from server
        if (resJson.FbiJson.FbiMsgsRs.statusCode === 1010) {
          this.connected = false;
          this.loggedIn = false;
          return;
        }

        this.connection.emit('done', null, resJson);
      } else {
        this.logger.info('Waiting for more data from Fishbowl...');
      }
    });
  };

  /**
   * Calls the next request in the queue
   */
  private deque = (): void => {
    this.waiting = false;
    if (this.reqQueue.length > 0) {
      const queuedReq = this.reqQueue.shift();
      this.sendRequest({ req: queuedReq.req, options: queuedReq.options, json: queuedReq.json }, queuedReq.cb);
    }
  };

  private loginToFishbowl = (): void => {
    this.sendRequest({ req: 'LoginRq' }, (err, res) => {
      this.deque();
    });
  };

  private parseExecuteQueryRqToJson = (s: any): any => {
    if (!Array.isArray(s.FbiJson.FbiMsgsRs.ExecuteQueryRs.Rows.Row)) {
      return s;
    }

    const row = s.FbiJson.FbiMsgsRs.ExecuteQueryRs.Rows.Row;
    for (let i = 0; i < row.length; i++) {
      row[i] = row[i].replace(/"/g, '');
    }

    const rows = [];
    const header = s.FbiJson.FbiMsgsRs.ExecuteQueryRs.Rows.Row[0].split(',');
    row.splice(0, 1);
    let data: any = {};
    for (const line of row) {
      const arr = line.split(',');
      header.forEach((key: string, j: number) => (data[key] = arr[j]));
      rows.push(data);
      data = {};
    }

    s.FbiJson.FbiMsgsRs.ExecuteQueryRs.Rows = rows;
    return s;
  };

  private parseImportHeaderRqToJson = (s: any): any => {
    let row = s.FbiJson.FbiMsgsRs.ImportHeaderRs.Header.Row;
    row = row.replace(/"/g, '');

    const o: { [k: string]: any } = {};
    const keys = row.split(',');
    keys.forEach((el: string) => (o[el] = ''));

    s.FbiJson.FbiMsgsRs.ImportHeaderRs.Header.Row = o;
    return s;
  };

  private parseJsonToCsv = (o: object[]): string[] => {
    const row: string[] = [];
    row.push(`${Object.keys(o[0])}`);

    for (const el of o) {
      row.push(`${Object.values(el)}`);
    }

    return row;
  };

  /*================================
          FISHBOWL REQUESTS
  ==================================*/

  private loginRequest = (): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: ''
        },
        FbiMsgsRq: {
          LoginRq: {
            IAID: this.IAID,
            IAName: this.IAName,
            IADescription: this.IADescription,
            UserName: this.username,
            UserPassword: crypto
              .createHash('md5')
              .update(this.password)
              .digest('base64')
          }
        }
      }
    });
  };

  private logoutRequest = (): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          LogoutRq: ''
        }
      }
    });
  };

  private executeQueryRq = (options: Types.ExecuteQuery): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          ExecuteQueryRq: {
            Name: options.name,
            Query: options.query
          }
        }
      }
    });
  };

  private importRq = (options: Types.ImportQuery): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          ImportRq: {
            Type: options.type,
            Rows: {
              Row: this.parseJsonToCsv(options.row)
            }
          }
        }
      }
    });
  };

  private importHeaderRq = (options: Types.ImportHeaderQuery): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          ImportHeaderRq: {
            Type: options.type
          }
        }
      }
    });
  };

  private issueSoRq = (options: Types.IssueSoQuery): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          IssueSORq: {
            SONumber: options.soNumber
          }
        }
      }
    });
  };

  private quickShipRq = (options: Types.QuickShipQuery): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          QuickShipRq: {
            SONumber: options.soNumber,
            fulfillServiceItems: options.fulfillServiceItems,
            errorIfNotFulfilled: options.errorIfNotFulfilled,
            shipDate: options.shipDate
          }
        }
      }
    });
  };

  private voidSoRq = (options: Types.VoidSoQuery): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          VoidSORq: {
            SONumber: options.soNumber
          }
        }
      }
    });
  };

  private customRq = (req: string, options: object): string => {
    return JSON.stringify({
      FbiJson: {
        Ticket: {
          Key: this.key
        },
        FbiMsgsRq: {
          [req]: options
        }
      }
    });
  };
};
