var express = require('express');
var router = express.Router();
var auth = require('../middleware/jwtMiddleware');
var mongoose = require('mongoose');
var Player = mongoose.model('Player');
var Authorization = mongoose.model('Authorization');
var Challenge = mongoose.model('Challenge');
var Alert = mongoose.model('Alert');
var NameService = require('../services/NameService');
var EmailService = require('../services/EmailService');
var AuthService = require('../services/AuthService');

/* 
 * POST new player
 *
 * @param: username
 * @param: password
 * @param: firstName
 * @param: lastName
 * @param: phone
 * @param: email
 */
router.post('/', function(req, res, next) {
	if ((req.body.username && typeof req.body.username !== 'string') ||
		(req.body.password && typeof req.body.password !== 'string') ||
		(req.body.firstName && typeof req.body.firstName !== 'string') ||
		(req.body.lastName && typeof req.body.lastName !== 'string') ||
		(req.body.phone && typeof req.body.phone !== 'number') ||
		(req.body.email && typeof req.body.email !== 'string'))
		return next(new Error('Invalid data type of Player parameters.'));
	
	var playerUsername = req.body.username ? req.body.username.trim() : null;
    var playerPassword = req.body.password ? req.body.password.trim() : null;
    var playerFirstName = req.body.firstName ? req.body.firstName.trim() : null;
	var playerLastName = req.body.lastName ? req.body.lastName.trim() : null;
	var playerPhone = req.body.phone;
	var playerEmail = req.body.email ? req.body.email.replace(/\s+/g, '') : "";

    // Create new player
    var player = new Player();
    player.username = playerUsername;
    player.firstName = playerFirstName;
    player.lastName = playerLastName;
    player.phone = playerPhone;
    player.email = playerEmail;


	Promise.all([
        AuthService.validatePasswordStrength(playerPassword),
		NameService.verifyRealName(player),
		NameService.verifyUsername(player.username),
		Player.usernameExists(player.username),
        EmailService.verifyEmail(player.email),
		Player.emailExists(player.email),
		Player.lowestRank()
	])
		.then(function(values) {
			// Set initial rank and persist player
			player.rank = values[6] + 1;
			return player.save();
		})
		.then(Alert.attachToPlayer)
		.then(function(player) {
            return Authorization.authorizePlayerWithPassword(player, playerPassword);
		})
		.then(function() {
            req.app.io.sockets.emit('player:new', playerUsername);
            console.log('Successfully created a new player.');
            res.json({message: 'Player created!'});
		})
		.catch(next);
});

/* 
 * POST changes player username
 *
 * @param: newName
 */
router.post('/change/username', auth.jwtAuthProtected, function(req, res, next) {
	var newUsername = req.body.newUsername ? req.body.newUsername.trim() : null;
    var clientId = AuthService.verifyToken(req.auth[1]).playerId;

	if (!clientId) return next(new Error('You must provide a valid player id.'));

	NameService.verifyUsername(newUsername)
		.then(Player.usernameExists)
		.then(function() {
            return Player.findById(clientId).exec()
		})
		.then(function(player) {
            if (!player) return Promise.reject(new Error('Could not find your account.'));
            player.username = newUsername;
            return player.save();
        })
		.then(function() {
            req.app.io.sockets.emit('player:change:username');
            res.json({message: 'Successfully changed your username to '+ newUsername});
		})
		.catch(next);
});

/*
 * POST changes player password
 *
 * @param: oldPassword
 * @param: newPassword
 */
router.post('/change/password', auth.jwtAuthProtected, function(req, res, next) {
	var oldPassword = req.body.oldPassword ? req.body.oldPassword.trim() : null;
    var newPassword = req.body.newPassword ? req.body.newPassword.trim() : null;
    var clientId = AuthService.verifyToken(req.auth[1]).playerId;

    console.log('Req body: ' + req.body.oldPassword);
    if (!clientId) return next(new Error('You must provide a valid player id.'));

    AuthService.validatePasswordStrength(newPassword)
		.then(function() {
            return Authorization.findByPlayerId(clientId);
		})
		.then(function(authorization) {
			console.log('Old password: ' + oldPassword);
			console.log('Auth passwrd: ' + authorization.password);
			if (authorization.password !== oldPassword) return Promise.reject(new Error('Incorrect current password.'));
            authorization.password = newPassword;
			return authorization.save();
		})
        .then(function() {
            req.app.io.sockets.emit('player:change:password');
            res.json({message: 'Successfully changed your password'});
        })
        .catch(next);
});


/* 
 * POST changes player email
 *
 * @param: newEmail
 */
router.post('/change/email', auth.jwtAuthProtected, function(req, res, next) {
	var newEmail = req.body.newEmail ? req.body.newEmail.replace(/\s+/g, '') : null;
    var clientId = AuthService.verifyToken(req.auth[1]).playerId;


    if (!clientId) return next(new Error('You must provide a valid player id.'));
	if (!newEmail || newEmail.length === 0) return next(new Error('You must provide an email address.'));
	if (newEmail.length > 50) return next(new Error('Your email length cannot exceed 50 characters.'));

    EmailService.verifyEmail(newEmail)
		.then(Player.emailExists(newEmail))
		.then(function() {
            return Player.findById(clientId).exec();
		})
		.then(function(player) {
            if (!player) return Promise.reject(new Error('Could not find your current account.'));
            console.log('Changing player email.');
            player.email = newEmail;
			return player.save();
		})
		.then(function() {
            req.app.io.sockets.emit('player:change:email');
            res.json({message: 'Successfully changed your email to '+ newEmail +'!'});
		})
		.catch(next);
});

/* 
 * POST removes player email */
router.post('/change/email/remove', auth.jwtAuthProtected, function(req, res, next) {
    var clientId = AuthService.verifyToken(req.auth[1]).playerId;

	if (!clientId) return next(new Error('You must provide a valid player id.'));
	
	console.log('Removing player email.');
	Player.findById(clientId).exec()
		.then(function(player) {
            if (!player) return Promise.reject(new Error('Could not find your current account.'));
            player.email = '';
            return player.save();
        })
		.then(function() {
			req.app.io.sockets.emit('player:change:email');
			res.json({message: 'Successfully removed your email!'});
		})
		.catch(next);
});


/* GET player listing */
router.get('/', auth.jwtAuthProtected, function(req, res, next) {
	Player.find({}).exec()
		.then(function(players) {
            res.json({message: players});
        })
		.catch(next);
});

/* GET player by id */
router.get('/fetch/:playerId', auth.jwtAuthProtected, function(req, res, next) {
	var playerId = req.params.playerId;
	if (!playerId) return next(new Error('You must specify a player id.'));
	
	Player.findById(playerId).exec()
		.then(function(player) {
            if (!player) return Promise.reject(new Error('No player was found for that id.'));
            res.json({message: player});
        })
		.catch(next);
});


/* GET the wins and losses for a player */
router.get('/record/:playerId', auth.jwtAuthProtected, function(req, res, next) {
	var playerId = req.params.playerId;
	if (!playerId) return next(new Error('You must specify a player id.'));

	Challenge.getResolved(playerId)
		.then(function(challenges) {
			var wins = 0;
			var losses = 0;
            challenges.forEach(function(challenge) {
                if (challenge.winner.toString() === playerId) wins++;
                else losses++;
            });
            res.json({message: {wins: wins, losses: losses}});
        })
		.catch(next);
});

module.exports = router;
