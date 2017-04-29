var path = require('path')
  , tb = require('timebucket')
  , moment = require('moment')
  , z = require('zero-fill')
  , n = require('numbro')
  , colors = require('colors')
  , fs = require('fs')
  , idgen = require('idgen')

module.exports = function container (get, set, clear) {
  var c = get('conf')
  return function (program) {
    program
      .command('sim <selector> [strategy_file]')
      .description('run a backtest simulation')
      .option('-s, --start <timestamp>', 'start at timestamp (milliseconds)')
      .option('-e, --end <timestamp>', 'end at timestamp (milliseconds)')
      .option('-d, --days <days>', 'start n days ago and end at latest data')
      .action(function (selector, strategy_file, cmd) {
        selector = get('lib.normalize-selector')(selector)
        var strategy = get('lib.load-strategy')(strategy_file)
        if (!cmd.end) {
          cmd.end = new Date().getTime()
        }
        if (cmd.days) {
          cmd.start = cmd.end - (86400000 * cmd.days)
        }
        var s = {
          selector: selector,
          asset: selector.split('.')[1].split('-')[0],
          currency: currency = selector.split('.')[1].split('-')[1],
          start: cmd.start,
          end: cmd.end,
          cursor: null,
          lookback: [],
          last_period_id: null,
          period: {},
          trend: null,
          signal: null,
          start_position: 50,
          buy_hold_start: null,
          day_count: 0,
          trade_count: 0,
          last_day: null,
          balance: {},
          my_trades: []
        }
        s.balance[s.currency] = strategy.options.start_capital
        s.balance[s.asset] = 0

        function initBuffer (trade) {
          s.period = {
            time: tb(trade.time).resize(strategy.options.period).toMilliseconds(),
            open: trade.price,
            high: trade.price,
            low: trade.price,
            close: trade.price,
            volume: 0
          }
        }

        function exitSim () {
          var size = s.balance[s.asset]
          s.balance[s.currency] += s.period.close * size
          s.balance[s.asset] = 0
          s.my_trades.push({
            time: s.period.time,
            type: 'sell',
            size: size,
            price: s.period.close
          })
          s.lookback.unshift(s.period)
          console.log(s.balance)
          var buy_hold = s.lookback[0].close * s.buy_hold_start
          console.log('buy hold', n(buy_hold).format('$0.00').yellow)
          console.log('vs. buy hold', n((s.balance[s.currency] - buy_hold) / buy_hold).format('0.00%').yellow)
          console.log(s.trade_count + ' trades over ' + s.day_count + ' days (avg ' + n(s.trade_count / s.day_count).format('0.0') + ' trades/day)')
          var data = s.lookback.map(function (period) {
            return {
              time: period.time,
              open: period.open,
              high: period.high,
              low: period.low,
              close: period.close,
              volume: period.volume
            }
          })
          var code = 'var data = ' + JSON.stringify(data) + ';\n'
          code += 'var trades = ' + JSON.stringify(s.my_trades) + ';\n'
          var tpl = fs.readFileSync(path.resolve(__dirname, '..', 'templates', 'sim_result.html.tpl'), {encoding: 'utf8'})
          var out = tpl.replace('{{code}}', code).replace('{{trend_ema_period}}', strategy.options.period.trend_ema || 36)
          var id = idgen(8)
          var out_target = 'sim_result_' + id + '.html'
          fs.writeFileSync(out_target, out)
          console.log('wrote', out_target)
          process.exit(0)
        }

        function onTrade (trade) {
          s.period.high = Math.max(trade.price, s.period.high)
          s.period.low = Math.min(trade.price, s.period.low)
          s.period.close = trade.price
          s.period.volume += trade.size
          s.cursor = trade.time
        }

        function generateEma () {
          ['trend_ema', 'price_ema'].forEach(function (k) {
            if (s.lookback.length >= strategy.options[k]) {
              var prev_ema = s.lookback[0][k]
              if (!prev_ema) {
                var sum = 0
                s.lookback.slice(0, strategy.options[k]).forEach(function (period) {
                  sum += period.close
                })
                prev_ema = sum / strategy.options[k]
              }
              var multiplier = 2 / (strategy.options[k] + 1)
              s.period[k] = (s.period.close - prev_ema) * multiplier + prev_ema
            }
          })
          if (s.period.trend_ema && s.lookback[0] && s.lookback[0].trend_ema) {
            if (s.period.trend_ema / s.lookback[0].trend_ema >= 1) {
              s.period.trend_ema_rate = (s.period.trend_ema - s.lookback[0].trend_ema) / s.lookback[0].trend_ema * 100
            }
            else {
              s.period.trend_ema_rate = (s.lookback[0].trend_ema - s.period.trend_ema) / s.period.trend_ema * -100
            }
          }
        }

        function generateRsi () {
          if (s.lookback.length >= strategy.options.rsi_periods) {
            var avg_gain = s.lookback[0].avg_gain
            var avg_loss = s.lookback[0].avg_loss
            if (typeof avg_gain === 'undefined') {
              var gain_sum = 0
              var loss_sum = 0
              var last_close
              s.lookback.slice(0, strategy.options.rsi_periods).forEach(function (period) {
                if (last_close) {
                  if (period.close > last_close) {
                    gain_sum += period.close - last_close
                  }
                  else {
                    loss_sum += last_close - period.close
                  }
                }
                last_close = period.close
              })
              s.period.avg_gain = gain_sum / strategy.options.rsi_periods
              s.period.avg_loss = loss_sum / strategy.options.rsi_periods
            }
            else {
              var current_gain = s.period.close - s.lookback[0].close
              s.period.avg_gain = ((avg_gain * (strategy.options.rsi_periods - 1)) + (current_gain > 0 ? current_gain : 0)) / strategy.options.rsi_periods
              var current_loss = s.lookback[0].close - s.period.close
              s.period.avg_loss = ((avg_loss * (strategy.options.rsi_periods - 1)) + (current_loss > 0 ? current_loss : 0)) / strategy.options.rsi_periods
            }
            var rs = s.period.avg_gain / s.period.avg_loss
            s.period.rsi = Math.round(100 - (100 / (1 + rs)))
          }
        }

        function emaSignal () {
          if (s.period.trend_ema_rate && s.lookback[0] && s.lookback[0].trend_ema_rate) {
            if (s.period.trend_ema_rate >= 0) {
              s.period.trend = 'up'
              s.signal = 'buy'
            }
            else {
              s.period.trend = 'down'
              s.signal = 'sell'
            }
            if (s.signal === 'buy' && s.period.trend_ema_rate >= 0.05) {
              //s.signal = null
            }
            else if (s.signal === 'sell' && s.period.trend_ema_rate <= -0.02) {
              s.signal = null
            }
          }
        }

        function executeSignal () {
          if (s.signal === 'buy') {
            var size = s.balance[s.currency] / s.period.close
            if (size >= 0.01 && s.balance[s.currency] - (s.period.close * size) >= 0 && s.period.close > 100)  {
              s.balance[s.asset] += size
              s.balance[s.currency] -= s.period.close * size
              s.action = 'bought'
              s.signal = null
              s.trade_count++
              s.my_trades.push({
                time: s.period.time,
                type: 'buy',
                size: size,
                price: s.period.close
              })
            }
          }
          else if (s.signal === 'sell') {
            var size = s.balance[s.asset]
            if (size >= 0.01 && s.balance[s.asset] - size >= 0 && s.period.close > 100)  {
              s.balance[s.asset] -= size
              s.balance[s.currency] += s.period.close * size
              s.action = 'sold'
              s.signal = null
              s.trade_count++
              s.my_trades.push({
                time: s.period.time,
                type: 'sell',
                size: size,
                price: s.period.close
              })
            }
          }
        }

        function generateReport () {
          process.stdout.write(moment(s.period.time).format('YYYY-MM-DD HH').grey)
          process.stdout.write(z(8, n(s.period.close).format('0.00'), ' ').white)
          if (s.lookback[0]) {
            var diff = s.period.close - s.lookback[0].close
            process.stdout.write(z(8, n(diff).format('0.00'), ' ')[diff >= 0 ? 'green' : 'red'])
          }
          else {
            process.stdout.write(z(8, '', ' '))
          }
          process.stdout.write(z(6, s.period.trend || 'null', ' ')[s.period.trend ? s.period.trend === 'up' ? 'green' : 'red' : 'grey'])
          if (s.period.trend_ema_rate) {
            process.stdout.write(z(8, n(s.period.trend_ema_rate).format('0.0000'), ' ')[s.period.trend ? s.period.trend === 'up' ? 'green' : 'red' : 'grey'])
          }
          else {
            process.stdout.write(z(9, '', ' '))
          }
          if (s.period.rsi) {
            var rsi_color = 'grey'
            if (s.period.rsi >= 70) rsi_color = 'green'
            else if (s.period.rsi <= 30) rsi_color = 'red'
            process.stdout.write(z(3, s.period.rsi, ' ')[rsi_color])
          }
          else {
            process.stdout.write(z(3, '', ' '))
          }
          process.stdout.write(z(9, s.action || 'null', ' ')[s.action ? s.action === 'bought' ? 'green' : 'red' : 'grey'])
          process.stdout.write(z(9, n(s.balance[s.asset]).format('0.0000'), ' ').white)
          process.stdout.write(z(10, n(s.balance[s.currency]).format('$0.00'), ' ').yellow)
          var consolidated = s.balance[s.currency] + (s.period.close * s.balance[s.asset])
          var profit = (consolidated - strategy.options.start_capital) / strategy.options.start_capital
          process.stdout.write(z(8, n(profit).format('0.00%'), ' ')[profit >= 0 ? 'green' : 'red'])
          process.stdout.write('\n')
        }

        function onCandle () {
          generateEma()
          generateRsi()
          emaSignal()
          executeSignal()
          generateReport()
          s.lookback.unshift(s.period)
          s.action = null
        }

        function getNext () {
          var opts = {
            query: {
              selector: selector,
              time: {$lte: s.end}
            },
            order: {time: 1},
            limit: 1000
          }
          if (s.cursor) {
            opts.query.time['$gt'] = s.cursor
          }
          else if (s.start) {
            opts.query.time['$gte'] = Number(s.start)
          }
          get('db.trades').select(opts, function (err, trades) {
            if (err) throw err
            if (!trades.length) {
              exitSim()
            }
            trades.sort(function (a, b) {
              if (a.time < b.time) return -1
              if (a.time > b.time) return 1
              return 0
            })
            trades.forEach(function (trade) {
              var period_id = tb(trade.time).resize(strategy.options.period).toString()
              var day = tb(trade.time).resize('1d')
              if (s.last_day && s.last_day.toString() && day.toString() !== s.last_day.toString()) {
                s.day_count += day.value - s.last_day.value
              }
              s.last_day = day
              if (!s.last_period_id) {
                initBuffer(trade)
                s.last_period_id = period_id
                s.buy_hold_start = s.balance[s.currency] / trade.price
              }
              if (period_id !== s.last_period_id) {
                onCandle()
                initBuffer(trade)
              }
              onTrade(trade)
              s.last_period_id = period_id
            })
            setImmediate(getNext)
          })
        }

        getNext()
      })
  }
}