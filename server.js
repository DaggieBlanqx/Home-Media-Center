/**
 * Created by Khalil on 2015-10-11.
 */

/********************************************************************************************************************/
/*********************************************** START-UP ******************************************************/

//Initialize Variables
var express = require('express');
var app = express();
var server = require('http').createServer(app);
var io = require('socket.io')(server);
var flow = require('nimble');
var filesystem = require('fs');
var id3 = require('id3js');
var config = require('./app_modules/config/config.js');
var async = require('async');
var media = require('mediaserver');
var ss = require('socket.io-stream');
var Client = require('./app_modules/client/client.js');
var ClientManager = require('./app_modules/client/clientmanager.js');

//Initialize database
var database = require('./app_modules/database/database.js');
//var MusicLibrary = require('.app_modules/models/library.js');

//Client Manager
var clientManager = new ClientManager();

//Start server
server.listen(config.configReader.network.port, function () {
    console.log('Server listening at port ', config.configReader.network.port);
});

//Make ENTIRE public directory routable
app.use(express.static(__dirname + '/public'));
app.use(express.static(__dirname + '/node_modules/socket.io/lib'));
app.use(express.favicon(__dirname  + "/public/src/favicon.ico"));


/********************************************************************************************************************/
/*********************************************** SOCKET EVENT HANDLING **********************************************/

io.on('connection', function (socket) {
    var client = new Client(socket);
    clientManager.addClient(client);
    console.log("New connection via: " + client.IP_ADDRESS + ". SocketID: " + client.id);

    //Add to listeners list
    socket.emit('current listeners', {
     //   listeners: JSON.stringify(listeners)
    });
    //listeners[socket.id] = socket.id;

    //Let everyone know that someone connected
    socket.broadcast.emit('a listener just connected', {
       user: socket.id
    });

    //When a client disconnects
    socket.on('disconnect', function () {
        //Let everyone know that the user left
        socket.broadcast.emit('a listener just left', {
           user: socket.id
        });

       // delete listeners[socket.id];
        console.log("socket disconnected");
        socket.disconnect();
    });

    //Get the information for a particular track (album artwork included)
    socket.on('getTrackInfo', function(data) {
        //Get TrackData
        console.log("The key is is :" + data.key);
        database.getSongViaKey(data.key, function(trackData){ //Note: we passed the value for data up 3 callbacks to get here
            id3({file: _safeProofTextUndo(trackData.FILE_LOCATION), type: id3.OPEN_LOCAL}, function(err, tags) {
                var ALBUM_ARTWORK = tags.v2.image;
                // tags now contains your ID3 tags
                socket.emit('trackInfo', {
                    artist:  _safeProofTextUndo(trackData.ARTIST),
                    song: _safeProofTextUndo(trackData.SONG),
                    album: _safeProofTextUndo(trackData.ALBUM),
                    year: _safeProofTextUndo(trackData.YEAR),
                    track_no: _safeProofTextUndo(trackData.TRACK_NO),
                    album_artwork: ALBUM_ARTWORK
                });
            });
        });
    });

    //**When a user starts listening to a song
    socket.on('i am listening to', function(data){
        var song = data.song;
        var artist = data.artist;
        var album = data.album;
        var key = data.key;
        var percent = data.percent;
        var time = data.time;


        socket.broadcast.emit('someone is listening to', {
            user: socket.id,
            song: song,
            artist: artist,
            album: album,
            key: key,
            percent: percent,
            time: time
        });
    });

    //When a user pauses or plays a song
    socket.on('song state change', function(data){
       var state = data.state;
       socket.broadcast.emit('song state change', {
           user: socket.id,
           state: state
       });
    });

    //Prevent client from timing out, send heartbeats
    function sendHeartbeat(){
        setTimeout(sendHeartbeat, 8000);
        io.sockets.emit('ping', { beat : 1 });
    }

    socket.on('pong', function(data){
    });

    setTimeout(sendHeartbeat, 8000);
});

/********************************************************************************************************************/
/*********************************************** HTTP REQUESTS ******************************************************/


//BUILD LIBRARY PAGE
app.get('/library', function(req, res){
    var JSON_ARRAY;
    flow.series([
        //GET ARRAY FROM DB
        function(callback){
            setTimeout(function() {
                JSON_ARRAY = database.getLibrary();
                callback();
            },300);
    },
        //PASS BACK AS JSON
        function(callback){
            setTimeout(function() {
                app.set('json spaces', 40);
                res.json(JSON.stringify(JSON_ARRAY));
                callback();
            },350);
        }
    ]);
});


//BUILD MAIN PAGE
app.get('/index', function(req, res){
    filesystem.createReadStream('./public/src/tempindex.txt').pipe(res);
});

//LOAD THE PLAYER
app.get('/player', function(req, res){
    filesystem.createReadStream('./public/src/player.txt').pipe(res);
});

//STREAM MUSIC
app.get('/stream', function(req, res){
    var SONG_ID = req.query.key;

    //Get TrackData
    database.getSongViaKey(SONG_ID, function(trackData){ //Note: we passed the value for data up 3 callbacks to get here
        console.log(trackData);
        media.pipe(req, res, _safeProofTextUndo(trackData.FILE_LOCATION));
    });
});

//GET Total Number of Songs
app.get('/songsTotal', function(req, res){
    var numberOfSongsJSONArr;
    flow.series([
        function(callback){
            setTimeout(function(){
                numberOfSongsJSONArr = database.getSongsTotal();
                callback();
            },30);
        },
        function(callback){
            setTimeout(function(){
                res.json(JSON.stringify(numberOfSongsJSONArr));
                callback();
            },40);
        }
    ]);
});

/********************************************************************************************************************/
/*********************************************** FUNCTIONS ******************************************************/


/* addMultipleSongs - This function takes a directory of songs as a parameter, then gets information
 *      about each song before throwing it into an insert statement and running it against the database.
 *
 * IMPORTANT: This function implements the async method: eachSeries which does not run the single iterations in parallel, but in serial.
 * async.eachSeries(array of items to iterate over, iterator function to perform on each item, an optional callback that is performed
 * when all items have been iterated over OR when the callback() throws an error like callback(new Error()).
 */



function addMultipleSongs(dirOfSongs) {
    var insertCommand = "INSERT INTO MYLIBRARY (TRACKID,SONG,ALBUM,ARTIST,YEAR,DATE_IMPORTED,TRACK_NO,FILE_LOCATION) VALUES ";
    var TRACK_ID = config.configReader.database.id_increment_count;
    var absCount = 1;

    _getAllFilesFromFolder(dirOfSongs, function parseArray(absFilesArray) {
        async.eachSeries(absFilesArray, function getID3ForEach(inputAudioFileLocation, callback) {
            id3({file: inputAudioFileLocation, type: id3.OPEN_LOCAL}, function (err, tags) {
                if (err) {
                    console.log("Could not get id3 tags for: " + inputAudioFileLocation);
                } else {
                    //We want to create a database INSERT
                    var title = _safeProofText(tags.title);
                    var artist = _safeProofText(tags.artist);
                    var album = _safeProofText(tags.album);
                    var year = _safeProofText(tags.year);
                    var trackNo = _safeProofText(tags.v1.track);

                    if(typeof title === undefined) title = "";
                    if(typeof artist === undefined) artist = "";
                    if(typeof album === undefined) album = "";
                    if(typeof year === undefined) year = "";
                    if(typeof trackNo === undefined) trackNo = "";

                    console.log(typeof title);

                    var date = new Date().toString();
                    var inputDate = date.substring(0, date.lastIndexOf(":") + 3);
                    var value = "(" + TRACK_ID + ", '" + title + "', '" + album + "', '" + artist + "', " + year + ", '" + inputDate + "', " + trackNo + ", '" + _safeProofText(inputAudioFileLocation) + "')";
                    if(absCount < absFilesArray.length){
                        value += ", ";
                    }
                    console.log(value);
                    insertCommand += value;
                    absCount++;
                    TRACK_ID++;
                    callback(); //required for async library
                }
            });
        }, function insert (err) {
                if (err) { throw err; }
                database.insertToDB(insertCommand, function updateConfig(success){
                    if(success){
                        config.configWriter.set('database:id_increment_count', TRACK_ID);
                        config.configWriter.save(function(err){
                            if(err) console.log("INSERT - Could not write to config file");
                            else console.log("INSERT - Wrote changes to config file");
                        });
                    } else {
                        console.log("INSERT - Did not write changes to config file");
                    }
                });
            }
        );
    });
}

/* Recursively finds all of the files from a directory
 * @return: Array of absolute file paths.
 * @see: addMultipleSongs (function)
 */

function _getAllFilesFromFolder(dir, callback) {
    var results = [];

    //Read each file in the current directory
    filesystem.readdirSync(dir).forEach(function(file) {

        file = dir+'/'+file;
        var stat = filesystem.statSync(file);

        if (stat && stat.isDirectory()) {
            results = results.concat(_getAllFilesFromFolder(file));
        } else{
            results.push(file);
        }
    });
    callback(results);
}

/*The purpose of this method is to change all potential dangerous text symbols that could mess up SQL
 queries.
 */

function _safeProofText(text){
    text = text + "";
    text = text.replace('\0', ''); // 10
    text = text.replace(/\0/g, '');
    text = text.replace(/["]/g,"**dbl**");
    text = text.replace(/[']/g,"**sgl**");
    text = text.replace(/[(]/g,"**op**");
    text = text.replace(/[)]/g,"**cl**");
    return text;
}

/*This method reverts the changed text used on SQL data, etc.
 USE THIS METHOD ON ALL DATA COMING BACK FROM DB.
 */

function _safeProofTextUndo(text){
    text = text + "";
    text = text.replace("**dbl**", '"');
    text = text.replace("**sgl**","'");
    text = text.replace("**op**","(");
    text = text.replace("**cl**",")");
    return text;
}


/*************************************************************************************************************/
/*********************************************** TEST FUNCTIONS **********************************************/
/************** (All functions are to start here before they are moved into their appropriate section) *******/

var ListenerRoom = require('./app_modules/listening/listenerroom.js');
var Listener = require('./app_modules/listening/listener.js');

var sock1 = {
    id: 'khalil'
};
var listener1 = new Listener(sock1);


var sock2 = {
    id: 'asia'
};
var listener2 = new Listener(sock2);


var room = new ListenerRoom();
room.addOrUpdateListener(listener1);
room.addOrUpdateListener(listener2);
console.log(room.getAllListeners());


