'use strict';

var redis = require('redis').createClient();
var Opmlparser = require('opmlparser');
var FeedParser = require('feedparser');
var url = require('url');
var http = require('http');
var request = require('request');
var AWS = require('aws-sdk');

var hash = require('./articles.js').hash;
var score = require('./articles.js').score;

var opmlparser = new Opmlparser();

exports.get = function (req, res) {
  redis.smembers('folders:' + req.params.user, function (e, folders) {
    var feeds = [];
    if (e) {
      res.status(500).json({
        'success': false,
        'error': {
          'type': 'Redis Error',
          'message': "Couldn't get folders for " + req.params.user
        }
      });
    } else {
      redis.sunion(folders, function (e, feedkeys) {
        if (e) {
          res.status(500).json({
            'success': false,
            'error': {
              'type': 'Redis Error',
              'message': "Couldn't get feeds from all folders for " + req.params.user
            }
          });
        } else {
          var feedurls = feedkeys.map(function (feedkey) {
            return feedkey.substr(5);
          });

          var unionkeys = feedurls.map(function (feedkey) {
            return 'articles:' + feedkey;
          }).concat('label:' + req.params.user + '/read');

          var weights = feedurls.map(function () {
            return -1;
          }).concat(1);

          redis.zunionstore(['articles:' + req.params.user, unionkeys.length].concat(unionkeys, 'weights', weights, 'aggregate', 'max'), function (e) {
            if (e) {
              res.status(500).json({
                'success': false,
                'error': {
                  'type': 'Redis Error',
                  'message': "Couldn't create article list for " + req.params.user,
                  'log': e.message
                }
              });
            } else {
              redis.zrangebyscore('articles:' + req.params.user, '-inf', '0', function (e, articles) {
                if (e) {
                  res.status(500).json({
                    'success': false,
                    'error': {
                      'type': 'Redis Error',
                      'message': "Couldn't get article list for " + req.params.user
                    }
                  });
                } else {
                  redis.del('articles:' + req.params.user, function (e) {
                    if (e) {
                      res.status(500).json({
                        'success': false,
                        'error': {
                          'type': 'Redis Error',
                          'message': "Couldn't delete article list for " + req.params.user
                        }
                      });
                    } else {
                      feedurls.forEach(function (feedurl, feedurlPosition) {
                        redis.hgetall('feed:' + feedurl, function (e, feed) {
                          if (!feed) feed = {};
                          feed.key = feedurl;
                          feeds.push(feed);
                          var article_ids = articles.map(function (key) {
                            return key.substr(8);
                          });
                          if (feedurlPosition === feedurls.length - 1) {
                            res.json({
                              'success': true,
                              'feeds': feeds,
                              'articles': article_ids
                            });
                          }
                        });
                      });
                    }
                  });
                }
              });
            }
          });
        }
      });
    }
  });
};

exports.feed = {};

exports.feed.get = function (configFilename) {
  AWS.config.loadFromPath(configPath);
  var s3 = new AWS.S3({
    params: {
      Bucket: 'feedreader2016-articles'
    }
  });

  return function (req, res) {
    var feedrequested = decodeURIComponent(req.url.slice(10));
    redis.hgetall('feed:' + feedrequested, function (e, feed) {
      if (e || !feed) feed = {};
      var unread = [];
      var headers = {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36'
      };
      if (feed.lastModified) headers['If-Modified-Since'] = feed.lastModified;
      if (feed.etag) headers['If-None-Match'] = feed.etag;

      var requ = request({
        'uri': feedrequested,
        'headers': headers
      }, function (e, response, body) {
        if (e) {
          res.status(500).json({
            'success': false,
            'error': {
              'type': 'Feed Error',
              'message': "Couldn't get " + feedrequested + " (" + e.message + ")",
              'log': e
            }
          });
        } else {
          redis.hmset('feed:' + feedrequested, 'lastModified', response.headers['last-modified'], 'etag', response.headers['etag'], function (e) {
            if (e) {
              res.status(500).json({
                'success': false,
                'error': {
                  'type': 'Redis Error',
                  'message': "Couldn't set lastModified and etag values for " + feedrequested
                }
              });
            }
          });
        }
      });

      var options = {};
      if (feed.link) {
        options = {
          'feedurl': feed.link
        };
      }

      var feedparser = new FeedParser(options);
      requ.pipe(feedparser);

      feedparser.on('error', function (e) {
        if (!e.type) e.type = 'Parser Error';
        if (!e.log) {
          e.log = e.message;
          e.message = "Couldn't parse the server response";
          if (!feed.errors) feed.errors = [];
          feed.errors.push({
            'type': e.type,
            'message': e.message,
            'log': e.log
          });
        }
      });

      feedparser.on('meta', function (meta) {
        redis.hmset('feed:' + feedrequested, 'title', meta.title, 'link', meta.link, function (e) {
          if (e) {
            res.status(500).json({
              'success': false,
              'error': {
                'type': 'Redis Error',
                'message': "Couldn't set title and link values for " + feedrequested
              }
            });
          }
        });
      });

      feedparser.on('readable', function () {
        var stream = this,
            article;
        while (article = stream.read()) {
          if (!(article.guid && article.description)) {
            return false;
          } else {
            article.hash = hash(article);
            article.score = score(article);
            article.feedurl = feedrequested;

            var body = JSON.stringify(article);
            var key = article.hash;
            var rank = article.score;

            redis.zscore('articles:' + feedrequested, 'article:' + key, function (e, oldscore) {
              if (e) {
                var err = new Error("Couldn't get score for article:" + key);
                err.type = 'Redis Error';
                err.log = e.message;
                stream.emit('error', err);
              } else {
                redis.zadd('articles:' + feedrequested, rank, 'article:' + key, function (e) {
                  if (e) {
                    var err = new Error("Couldn't add article:" + key + " to articles:" + feedrequested);
                    err.type = 'Redis Error';
                    err.log = e.message;
                    stream.emit('error', err);
                  } else {
                    if (oldscore == null || rank != oldscore) {
                      s3.putObject({
                        Key: key,
                        Body: body,
                        ContentType: 'application/json'
                      }, function (e) {
                        if (e) {
                          var err = new Error("Couldn't put " + key + " in the S3 bucket");
                          err.type = 'S3 Error';
                          err.log = e.message;
                          console.log(err);
                          stream.emit('error', err);
                        }
                      });
                    }
                  }
                });
              }
            });
          }
        }
      });

      feedparser.on('end', function () {
        redis.zrevrange('articles:' + feedrequested, 0, -1, function (e, all_articles) {
          if (e) {
            res.status(500).json({
              'success': false,
              'error': {
                'type': 'Redis Error',
                'message': "Couldn't get articles for " + feedrequested
              }
            });
          } else {
            feed.success = true;
            feed.articles = all_articles.map(function (key) {
              return key.substr(8);
            });
            res.json(feed);
          }
        });
      });
    });
  };
};