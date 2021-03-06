const cls = require('continuation-local-storage');
import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as amqp from 'amqplib';
import * as uuid from 'node-uuid';

import { Events } from '../utils/event';
import { AmqpChannelPoolService } from './amqp-channel-pool-service';
import { Message, Event, EventHandler, Subscriber, EventSubscriber, PatternSubscriber } from './event-subscriber';

import { TraceLog } from '../utils/tracelog';
import { logger } from '../utils/logger';
import reviver from '../utils/reviver';

function enterScope(properties: any, func): Promise<any> {
  return new Promise((resolve, reject) => {
    const ns = cls.getNamespace('app');
    ns.run(() => {
      _.each(properties, (value, key) => {
        ns.set(key, value);
      });
      Bluebird.try(func).then(resolve).catch(reject);
    });
  });
}

export class EventService {
  private static EXCHANGE_NAME: string = 'MESSAGE_BROKER_EXCHANGE';
  private channelPool: AmqpChannelPoolService;
  private roundRobinQ: string;
  private fanoutQ: string;
  private subscribers: Subscriber[] = [];
  private serviceName: string;
  
  constructor(serviceName: string) {
    this.serviceName = serviceName; 
    this.roundRobinQ = `event.${serviceName}`;
    this.fanoutQ = `event.${serviceName}.node.${uuid.v4()}`;
  }

  async initialize(channelPool: AmqpChannelPoolService): Promise<any> {
    await TraceLog.initialize();
    
    this.channelPool = channelPool;
    return channelPool.usingChannel(channel => {
      return channel.assertExchange(EventService.EXCHANGE_NAME, 'topic', {durable: true})
        .then(() => channel.assertQueue(this.roundRobinQ, {durable: true, exclusive: false}))
        .then(() => channel.assertQueue(this.fanoutQ, {exclusive: true, autoDelete: true}));
    });
  }

  startConsume(): Promise<any> {
    return this.channelPool.acquireChannel()
      .then(channel => {
        return Bluebird.map([this.roundRobinQ, this.fanoutQ], queue => {
          return this.registerConsumer(channel, queue);
        });
      })
      .then(() => {
        this.publishEvent(new Events.SystemNodeStarted({name: this.fanoutQ, island: this.serviceName}));
      });
  }

  private registerConsumer(channel: amqp.Channel, queue: string): Promise<any> {
    return Promise.resolve(channel.consume(queue, msg => {
      if (!msg) {
        logger.error(`consume was canceled unexpectedly`);
        // TODO: handle unexpected cancel
        return;
      }
      Bluebird.resolve(this.handleMessage(msg))
        .catch(e => {
          logger.error(`error on handling event: ${e}`);
          // TODO: define island error and publish log.eventError
        })
        .finally(() => {
          channel.ack(msg);
          // TODO: fix me. we're doing ACK always even if promise rejected.
          // TODO: how can we handle the case subscribers succeeds or fails partially
        });
    }));
    // TODO: save channel and consumer tag
  }

  private handleMessage(msg: Message): Promise<any> {
    const headers = msg.properties.headers;
    const tattoo = headers && headers.tattoo;
    const content = JSON.parse(msg.content.toString('utf8'), reviver);
    logger.debug(`${msg.fields.routingKey}`, content, msg.properties.headers);
    const subscribers = this.subscribers.filter(subscriber => subscriber.isRoutingKeyMatched(msg.fields.routingKey));
    const promise = Bluebird.map(subscribers, subscriber => {
      return enterScope({RequestTrackId: tattoo, Context: msg.fields.routingKey, Type: 'event'}, () => {
        const log = new TraceLog(tattoo, msg.properties.timestamp || 0) ;
        log.size = msg.content.byteLength;
        log.from = headers.from;
        log.to = { node: process.env.HOSTNAME, context: msg.fields.routingKey, island: this.serviceName, type: 'event' };

        return Bluebird.resolve(subscriber.handleEvent(content, msg))
          .then(() => {
            log.end();
          })
          .catch(e => {
            log.end(e);
            throw e;
          })
          .finally(() => {
            log.shoot();
          });
      });
    });
    return Promise.resolve(promise);
  }

  purge(): Promise<any> {
    // TODO: cancel consume
    return Promise.resolve();
  }

  subscribeEvent<T extends Event<U>, U>(eventClass: new (args: U) => T,
                                        handler: EventHandler<T>,
                                        options?: SubscriptionOptions): Promise<void> {
    return Promise.resolve(Bluebird.try(() => new EventSubscriber(handler, eventClass))
      .then(subscriber => this.subscribe(subscriber, options)));
  }

  subscribePattern(pattern: string,
                   handler: EventHandler<Event<any>>,
                   options?: SubscriptionOptions): Promise<void> {
    return Promise.resolve(Bluebird.try(() => new PatternSubscriber(handler, pattern))
      .then(subscriber => this.subscribe(subscriber, options)));
  }

  private subscribe(subscriber: Subscriber, options?: SubscriptionOptions): Promise<void> {
    options = options || {};
    let queue = options.everyNodeListen && this.fanoutQ || this.roundRobinQ;
    return this.channelPool.usingChannel(channel => {
        return channel.bindQueue(queue, EventService.EXCHANGE_NAME, subscriber.getRoutingPattern());
      })
      .then(() => {
        this.subscribers.push(subscriber);
      });
  }
  
  private _publish(exchange: string, routingKey: string, content, options): Promise<any> {
    return this.channelPool.usingChannel(channel => {
      return Promise.resolve(channel.publish(exchange, routingKey, content, options));
    });
  }

  // TODO: implement unsubscribe

  publishEvent<T extends Event<U>, U>(exchange: string, event: T): Promise<any>;
  publishEvent<T extends Event<U>, U>(event: T): Promise<any>;
  publishEvent(...args): Promise<any> {
    let exchange = EventService.EXCHANGE_NAME;
    let event: Event<{}>;
    if (args.length === 1) {
      event = args[0];
    } else {
      exchange = args[0];
      event = args[1];
    }
    const ns = cls.getNamespace('app');
    const tattoo = ns.get('RequestTrackId');
    const context = ns.get('Context');
    const type = ns.get('Type');
    logger.debug(`publish ${event.key}`, event.args, tattoo);
    const options = {
      timestamp: +new Date(),
      headers: {
        tattoo,
        from: { node: process.env.HOSTNAME, context, island: this.serviceName, type }
      }
    };
    return Promise.resolve(Bluebird.try(() => new Buffer(JSON.stringify(event.args), 'utf8'))
      .then(content => {
        return this._publish(EventService.EXCHANGE_NAME, event.key, content, options);
      }));
  }
}

export interface SubscriptionOptions {
  everyNodeListen?: boolean;
}

