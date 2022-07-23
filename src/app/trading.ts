// noinspection JSMismatchedCollectionQueryUpdate

import { Logger } from "@nestjs/common";
import { KujiraService } from "../kujira.service";
import { v4 as uuid } from "uuid";
import { TelegramService } from "nestjs-telegram";
import { EMPTY, forkJoin, Observable } from "rxjs";
import * as Telegram from "nestjs-telegram/dist/interfaces/telegramTypes.interface";

export class Trading {
  private readonly logger = new Logger(Trading.name);

  public _state: ClientState = ClientState.INITIALIZE;

  private balanceBase: number;

  private balanceQuote: number;

  private _balanceRate: number;

  private balanceTotal: number;

  private readonly baseSymbol: string;

  private readonly quoteSymbol: string;

  private _marketPrice: number;

  private _marketRate: number;

  public ongoing: boolean = false;

  private actions: string[] = [];

  private _targetRate: number | undefined;

  private currentOrders: Order[];

  private lastMarketQueried = new Date();

  private lastBalanceQueried = new Date();

  private CHAT_ID: string = process.env.TELEGRAM_CHAT_ID;

  constructor(
    private readonly telegram: TelegramService,
    private readonly _service: KujiraService,
    private _wallet: Wallet,
    private _contract: Contract,
    private _deltaRates: number[],
    _targetRate?: number,
  ) {
    this.baseSymbol = this._service.toSymbol(this._contract.denoms.base)
    this.quoteSymbol = this._service.toSymbol(this._contract.denoms.quote)
    this._targetRate = _targetRate;
  }

  async next() {
    let message;
    let fulfilledOrders: Order[];
    let unfilledOrders: Order[];
    switch (this._state) {
      case ClientState.INITIALIZE:
        await this.market();
        await this.balances();
        // 자산비율(balance rate)와 설정비율을 확인해서 {n%} 이상 차이날 경우, 실행하지 않는다.
        if (Math.abs(this._balanceRate - this._targetRate) >= this._deltaRates[0]) {
          throw new Error(`current rate[${this._balanceRate}] is greater than config rate[${this._deltaRates[0]}].`);
        }
        // 진행중인 주문이 있으면, ORDER_CHECK 로 변경한다.
        this.currentOrders = await this.getOrders();
        if (this.currentOrders.length === 1) {
          this._state = ClientState.WAITING_ALL_ORDER_COMPLETE;
          return;
        } else if (this.currentOrders.length > 1) {
          this._state = ClientState.ORDER_CHECK;
          return;
        }
        this._state = ClientState.ORDER;
        return;
      case ClientState.ORDER:
        // 진행중인 주문이 있으면, ORDER_CHECK 로 변경한다.
        this.currentOrders = await this.getOrders();
        if (this.currentOrders.length > 0) {
          this._state = ClientState.ORDER_CHECK;
          return;
        }
        // TODO market price caching.
        await this.market();
        const marketPrice = this._marketPrice;
        this.logger.debug(`balance rate at current is ${this.balanceBase * marketPrice / (this.balanceBase * marketPrice + this.balanceQuote)}`)
        const tps: OrderMarketMaking[] = this._deltaRates
          .map(r => [r, -r]).flat()
          .map(r => {
            // 자산비율이 주문비율{1%,2%}에 해당하는 목표가격을 {tp1, tp2} 찾는다.
            const price = marketPrice + marketPrice * r;
            this.logger.debug(`balance target rate is ${this._targetRate}`)
            this.logger.debug(`balance rate at target is ${this.balanceBase * price / (this.balanceBase * price + this.balanceQuote)}`)
            // 주문비율의 가격에서 변동자산가치를{tot1, tot2} 계산한다.
            const curTot = this.balanceBase * marketPrice + this.balanceQuote;
            const tot = this.balanceBase * price + this.balanceQuote;
            this.logger.debug(`value will change from ${curTot}(${marketPrice}) to ${tot}(${price})`)
            // 변동자산가치에서 목표비율을 곱해 목표가의 갯수를{baseQuan}를 계산한다.
            const base = tot * this._targetRate / price;
            // 목표수량과 현재 수량만큼의 차이인 주문수량{dq1, dq2} 계산한다.
            const dq = base - this.balanceBase;
            this.logger.debug(`quantity will change from ${this.balanceBase} to ${base}, delta is ${dq}`)
            // 부호가 다르면, 가격 이격이 발생.
            const normal = r * dq < 0;
            return { price, tot, base, dq, rate: r, normal};
          });
        const notNormal = tps.filter(tp => !tp.normal);
        if (notNormal.length > 0) {
          this.logger.warn(`[price] found gap between market price{${marketPrice}} and order price{${notNormal[0].price}}`)
          this._state = ClientState.WAITING_ALL_ORDER_COMPLETE;
          const order = notNormal.sort((o1, o2) =>
            // if buy order is not normal, sell at maximum buy order price.
            o1.rate > 0 // buy order
              ? this.desc(o1.price, o2.price) // get maximum price
              : this.asc(o1.price, o2.price) // get minimum
          )[0];
          order.rate = -1 * order.rate;
          const orders = this.toOrderRequests(this._contract, [order]);
          this.logger.log(`[orders] request: ${JSON.stringify(orders)}`);
          await this._service.orders(this._wallet, orders);
          return;
        }
        // 주문수량의 주문정보{o}를 생성한다.
        const sellOrders = tps.filter(tp => tp.rate > 0)
          .sort((n1, n2) => this.asc(n1.price, n2.price));
        const buyOrders = tps.filter(tp => tp.rate < 0)
          .sort((n1, n2) => this.desc(n1.price, n2.price));
        const orders = [
          ...this.toOrderRequests(this._contract, sellOrders),
          ...this.toOrderRequests(this._contract, buyOrders)
        ];
        // TODO 주문정보{o} 시장가로 거래 가능한지 판단한다.
        // TODO 시장가로 거래가 가능할 경우: 주문 후 MARKET_ORDER_CHECK 로 변경
        // 시장가로 거래가 가능하지 않을 경우:
        // 주문정보{o} 실행한다.
        this.logger.log(`[orders] ${JSON.stringify(orders)}`);
        await this._service.orders(this._wallet, orders);
        message = orders
          .sort((n1, n2) => this.desc(n1.price, n2.price))
          .map(o => `${o.side} ${o.amount.toFixed(4)} ${o.side === 'Sell' ? this.baseSymbol : this.quoteSymbol} at ${o.price.toFixed(this._contract.price_precision.decimal_places)} ${this.quoteSymbol}`).join('\n');
        this.sendMessage(`Orders\n${message}`)
          .subscribe()
        this._state = ClientState.ORDER_CHECK;
        return;
      case ClientState.ORDER_CHECK:
        this.currentOrders = await this.getOrders();
        if (this.currentOrders.length === 0) {
          this._state = ClientState.ORDER;
          return;
        }
        // 주문 회수에 실패한 경우
        if (this.currentOrders.length !== this._deltaRates.length * 2) {
          this._state = ClientState.CANCEL_ALL_ORDERS;
          return;
        }
        fulfilledOrders = this.currentOrders.filter(o => o.state === 'Closed');
        unfilledOrders = this.currentOrders.filter(o => o.state !== 'Closed');
        // 진행중인 주문이 있는 경우, {n}개의 주문이 완료됨을 기다린다.
        if (fulfilledOrders.length >= this._deltaRates.length) {
          this._state = ClientState.FULFILLED_ORDERS;
          return;
        }
        const idxs = this.currentOrders.map(o => o.idx);
        this.actions.push(`[order state] idxs: ${idxs.join(',')} fulfilled orders: ${fulfilledOrders.length}`)
        return;
      case ClientState.FULFILLED_ORDERS:
      case ClientState.CANCEL_ALL_ORDERS:
        this.currentOrders = await this.getOrders();
        fulfilledOrders = this.currentOrders.filter(o => o.state === 'Closed');
        unfilledOrders = this.currentOrders.filter(o => o.state !== 'Closed');
        this.actions.push(`[orders] withdraw: ${JSON.stringify(fulfilledOrders.map(o => o.idx).join(','))}`);
        this.actions.push(`[orders] cancel: ${JSON.stringify(unfilledOrders.map(o => o.idx).join(','))}`);
        await this._service.ordersWithdraw(this._wallet, this._contract, fulfilledOrders);
        await this._service.ordersCancel(this._wallet, this._contract, unfilledOrders);
        this._state = ClientState.ORDER;
        forkJoin([
          this.sendMessage(`Withdraw\n${fulfilledOrders.map(o => `${o.idx}`).join(',')}`),
          this.sendMessage(`Cancel\n${unfilledOrders.map(o => `${o.idx}`).join(',')}`)
        ]).subscribe()
        return;
      case ClientState.MARKET_ORDER_CHECK:
        // 즉시 거래가능한 지정가 거래이므로, 주문을 모두 회수하고 ORDER 로 상태 변경한다.
        return;
      case ClientState.WAITING_ALL_ORDER_COMPLETE:
        this.currentOrders = await this.getOrders();
        if (this.currentOrders.length === 0) {
          this._state = ClientState.ORDER;
          return;
        }
        if (this.currentOrders.filter(o => o.state !== 'Closed').length === 0) {
          this._state = ClientState.FULFILLED_ORDERS;
        }
        return;
    }
  }

  async getOrders() {
    return this._service.getOrders(this._wallet, this._contract)
  }

  async balances() {
    const SEC = 1_000
    if (!this.balanceBase && new Date().getTime() - this.lastBalanceQueried.getTime() < 5 * SEC) {
      return;
    }
    const balances = await this._service.fetchBalances(
      this._wallet,
      this._contract,
    );
    const base = balances.filter((b) => b.denom === this._contract.denoms.base)[0];
    const quote = balances.filter((b) => b.denom === this._contract.denoms.quote)[0];
    if (!base) {
      const message = `invalid base balance: ${this._contract.denoms.base}`;
      throw new Error(message);
    }
    if (!quote) {
      const message = `invalid quote balance: ${this._contract.denoms.quote}`;
      throw new Error(message);
    }
    const bAmount = Number(base.amount);
    const qAmount = Number(quote.amount);
    const {rate, totalValue} = this.balanceStat(bAmount, qAmount, this._marketPrice);
    this._balanceRate = rate;
    this.balanceBase = bAmount;
    this.balanceQuote = qAmount;
    this.balanceTotal = totalValue;
    if (!this._targetRate) {
      this._targetRate = this._balanceRate;
    }
    this.actions.push(`[balances] base/quote: ${bAmount}${this.baseSymbol}/${qAmount}${this.quoteSymbol}, balanceTotal: ${totalValue}${this.quoteSymbol}, balanceRate: ${rate}, targetRate: ${this._targetRate}`);
  }

  balanceStat(base: number, quote: number, price: number) {
    const baseValue = base * price;
    const totalValue = baseValue + quote;
    return {
      base, quote, price,
      baseValue, totalValue,
      rate: baseValue / totalValue
    }
  }

  async market() {
    const SEC = 1_000
    if (!this._marketPrice && new Date().getTime() - this.lastMarketQueried.getTime() < 5 * SEC) {
      return;
    }
    this.lastMarketQueried = new Date()
    const orders = await this._service.books(this._wallet, this._contract, {
      limit: 1,
    });
    if (orders.base.length !== 1) throw new Error('orders.base.length !== 1');
    if (orders.quote.length !== 1) throw new Error('orders.quote.length !== 1');
    const base = Number(orders.base[0].quote_price);
    const quote = Number(orders.quote[0].quote_price);
    this._marketPrice = (base + quote) / 2;
    this._marketRate = base * this._marketPrice / (base * this._marketPrice + base);
    this.actions.push(`[market] price: ${this._marketPrice}, rate: ${this._marketRate}`)
  }

  toOrderRequests(contract: Contract, orders: OrderMarketMaking[]): OrderRequest[] {
    let prevQuantities = 0;
    return orders
      .map(o => {
        const quantity = Math.abs(o.dq) - prevQuantities;
        const o2 = {
          ...o,
          dq: quantity
        };
        prevQuantities += quantity;
        return o2;
      })
      .map(o => {
        const side = o.rate > 0 ? 'Sell' : 'Buy';
        const amount = Math.abs(side === 'Sell' ? o.dq : (o.dq * o.price));
        return {
          uuid: uuid(),
          contract,
          side,
          price: o.price,
          amount,
        }
      });
  }

  desc(n1: number, n2: number): number {
    return n1 < n2 ? 1 : -1
  }

  asc(n1: number, n2: number): number {
    return this.desc(n1, n2) > 1 ? -1 : 1;
  }

  public printStart() {
    this.logger.log(`[start] ${this._state}`)
    return this._state;
  }

  public printEnd(beforeState: ClientState) {
    this.actions.forEach(a => this.logger.log(a));
    if (beforeState !== this._state) {
      this.logger.log(`[end] ${beforeState} => ${this._state}`)
    } else {
      this.logger.log(`[end] ${this._state}`)
    }
    if (this.actions.length !== 0)
      this.actions = [];
  }

  async reconnect() {
    this.logger.log('[wallet] reconnect...');
    this._wallet = await this._service.reconnect(this._wallet)
  }

  sendMessage(message: string): Observable<Telegram.TelegramMessage> {
    if (!this.CHAT_ID) {
      return EMPTY;
    }
    return this.telegram.sendMessage({ chat_id: this.CHAT_ID, text: message }) as any
  }
}

enum ClientState {
  INITIALIZE = 'INITIALIZE',
  ORDER = 'ORDER',
  FULFILLED_ORDERS = 'FULFILLED_ORDERS',
  CANCEL_ALL_ORDERS = 'CANCEL_ALL_ORDERS',
  ORDER_CHECK = 'ORDER_CHECK',
  MARKET_ORDER_CHECK = 'MARKET_ORDER_CHECK',
  WAITING_ALL_ORDER_COMPLETE = 'WAITING_ALL_ORDER_COMPLETE',
}
