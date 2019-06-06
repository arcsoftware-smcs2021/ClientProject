const express = require('express')
const router = express.Router()
const lti = require('ims-lti')
const fetch = require('node-fetch')
const pug = require('pug')
const rimraf = require('rimraf')

const fs = require('fs')

// Import other pieces of code, these contain algorithms specific to the peer review features
const assign = require('../lib/assign')
const docx = require('../lib/docx')

// These are adapters that handle interfacing with the Canvas API and Firestore
const CanvasAdapter = require('../dataAdapters/canvasAdapter')
const firestore = require('../dataAdapters/firestoreAdapter')

// Initialize a store for the Canvas tool provider objects, as they are not saved by the
// session store provided by Express
router.providers = {}

// Handles a POST request to /, this request is generated by Canvas when the tool is picked on the edit assignment page
router.post('/', (req, res, next) => {
  // Context: teacher adding the tool to an assignment

  // Create provider and session data
  req.session.provider = new lti.Provider(req.body.oauth_consumer_key, 'BBBB') // The provider object handles the External Tool interaction
  req.session.providerId =
    req.body.oauth_consumer_key + req.session.provider.custom_canvas_user_id
  router.providers[req.session.providerId] = req.session.provider
  req.session.key = req.body.oauth_consumer_key

  // Validate the external tool request
  req.session.provider.valid_request(req, (err, is_valid) => {
    if (err) return res.status(500).send(err)
    if (!is_valid) return res.status(401).send('invalid sig')

    // Make sure we have the right context, this interaction returns a URL that is then used on the assignment page
    if (
      req.session.provider.ext_content &&
      req.session.provider.ext_content.has_return_type('lti_launch_url')
    ) {
      // Check if the course has completed the onboarding process
      const courseId =
        req.body.oauth_consumer_key +
        req.session.provider.body.custom_canvas_course_id
      firestore.checkCourseOnboard(courseId).then(r => {
        if (r) {
          const course = r.data()
          req.session.canvasAdapter = new CanvasAdapter(
            course.apiKey,
            'https://' + req.session.provider.body.custom_canvas_api_domain
          )

          // Pull down all assignments in the class from Canvas API
          req.session.canvasAdapter
            .getAssignments(req.session.provider.body.custom_canvas_course_id)
            .then(r => {
              // Render the assignment selector
              res.render('assignmentSelector', {
                title: 'Peer Review',
                assignments: r
              })
            })
            .catch(e => {
              console.log(e)
              res.status(500).send(e)
            })
        } else {
          // If we're here, we don't have an API key for the course and need to prompt for one
          req.session.url =
            'https://' + req.session.provider.body.custom_canvas_api_domain

          // Redirect to the onboad page
          res.redirect(
            '/onboard/' +
              courseId +
              '/' +
              req.session.provider.body.custom_canvas_course_id
          )
        }
      })
    } else {
      // If we're in an invalid state, abort
      res.send('Error: Incorrect LTI URL or wrong state')
    }
  })
})

router.post('/assignment/:course/:assignment/review', (req, res, next) => {
  // Context: LTI interaction from a student or teacher visiting the assignment page

  // Create provider and session data
  req.session.provider = new lti.Provider(req.body.oauth_consumer_key, 'BBBB')
  req.session.providerId =
    req.body.oauth_consumer_key + req.session.provider.custom_canvas_user_id
  router.providers[req.session.providerId] = req.session.provider
  req.session.key = req.body.oauth_consumer_key

  // Validate the request
  req.session.provider.valid_request(req, (err, is_valid) => {
    if (err) return res.status(500).send(err)
    if (!is_valid) return res.status(401).send('invalid sig')

    if (req.session.provider.student) {
      // If we're a student we either need to complete reviews or view reviews on our paper
      firestore
        .checkReviewsCompleted(req.session.provider.body.custom_canvas_user_id)
        .then(completed => {
          if (completed) {
            // If the student is done, we fetch the reviews other students have done of them
            firestore
              .getReviewsOfUser(
                req.params.assignment,
                req.session.provider.body.custom_canvas_user_id
              )
              .then(reviews => {
                // Count how many reviews are still pending
                let incompleteCount = 0

                for (const review of reviews) {
                  if (review.status !== 'complete') incompleteCount++
                }

                res.render('viewReviewsStudent', {
                  title: 'Peer Review',
                  reviews,
                  incompleteCount
                })
              })
          } else {
            // If the student is not done, we fetch the reviews they need to do
            firestore
              .getReviewsFromUser(
                req.params.assignment,
                req.session.provider.body.custom_canvas_user_id
              )
              .then(reviews => {
                res.render('review', {
                  title: 'Peer Review',
                  reviews
                })
              })
              .catch(e => {
                console.log(e)
                res.status(500).send(e)
              })
          }
        })
    } else if (req.session.provider.instructor || req.session.provider.ta) {
      // For a teacher we need to get all the submissions and their reviews
      // The teacher in this view sees the reviews by the author, to see by reviewer they use SpeedGrader
      firestore.getSubmissions(req.params.assignment).then(submissions => {
        // Complicated one liner, iterates over all the submissions and gets their data
        Promise.all(submissions.map(sub => sub.get())).then(
          async submissionData => {
            // This gets a list of all students who submitted work to the assignment
            const authors = submissionData.map(sub => sub.get('author'))
            let students = []

            // Looping through all the authors
            for (const author of authors) {
              const authorData = await author.get()

              // Create an object to pass to the front end that represents the student in the context of being reviewed
              const student = {
                reviews: await firestore.getReviewsOfUser(
                  req.params.assignment,
                  author.id
                ),
                id: author.id,
                name: (await author.get()).get('name'),
                incompleteCount: 0
              }

              // Count incomplete reviews
              for (const review of student.reviews) {
                if (review.status !== 'complete') student.incompleteCount++
              }

              // Add the student to the array
              students.push(student)
            }

            // Render the list of reviews
            res.render('viewReviewsTeacher', {
              title: 'Peer Review',
              students
            })
          }
        )
      })
    } else {
      res.send('This assignment type is unsupported for your user role.')
    }
  })
})

router.post(
  '/assignment/:course/:assignment/review/:reviewId',
  (req, res, next) => {
    // Context: Student updating their review
    // Called by Javascript on the client

    // Restore provider from serialization
    req.session.provider = router.providers[req.session.providerId]
    const userId = req.session.provider.body.custom_canvas_user_id

    // Add the completed review to the database
    firestore
      .completeReview(req.params.reviewId, userId, req.body)
      .then(complete => {
        if (complete) {
          // Build the document that represents the reviews the student did
          firestore
            .getReviewsFromUser(req.params.assignment, userId)
            .then(async reviews => {
              let resString = ''

              // Loop through each review and build a string
              for (const review of reviews) {
                const submission = await review.submission.get()
                const author = await submission.get('author')
                resString += '<p><b>Review of ' + author.id + '</b><br/>'

                // Instead of building the whole string, this pug file is a shortcut to a function defined in
                // viewReview.pug that is used to render reviews in other parts of the code
                resString += pug.compileFile('src/views/renderReview.pug', {})({
                  review
                })
              }

              // Submit the document of reviews
              req.session.provider.outcome_service.send_replace_result_with_text(
                1,
                resString,
                (err, result) => {
                  if (err) throw err
                  res.send('refresh')
                }
              )
            })
            .catch(e => {
              console.log(e)
              res.status(500).send(e)
            })
        } else {
          // If we aren't complete, send a different status code so the client knows
          res.status(202).send('')
        }
      })
      .catch(e => {
        console.log(e)
        res.status(500).send(e)
      })
  }
)

router.get('/info/:course/:assignment', (req, res, next) => {
  // Restore adapter from serialization
  req.session.canvasAdapter = new CanvasAdapter(
    req.session.canvasAdapter.apiKey,
    req.session.canvasAdapter.host
  )

  req.session.canvasAdapter
    .getAssignmentSubmissions(req.params.course, req.params.assignment)
    .then(submissions => {
      req.session.canvasAdapter
        .getAssignment(req.params.course, req.params.assignment)
        .then(async assignment => {
          console.log(submissions)

          for (const submission of submissions) {
            // Pull out attachment data and create download path
            const attachment = submission.attachments[0]
            const downloadDir = 'tmp/documents/' + attachment.uuid
            const documentPath = downloadDir + '/' + attachment.uuid + '.docx'

            // Make sure all needed directories exist
            if (!fs.existsSync('tmp/')) fs.mkdirSync('tmp/')
            if (!fs.existsSync('tmp/documents')) fs.mkdirSync('tmp/documents')
            if (!fs.existsSync('public/documents'))
              fs.mkdirSync('public/documents')

            // Download the attachment, we create a stream to write to
            const res = await fetch(attachment.url)
            await new Promise((resolve, reject) => rimraf(downloadDir, resolve))
            fs.mkdirSync(downloadDir)
            const outputFileStream = fs.createWriteStream(documentPath)

            // Wrap this in a promise to synchronize
            await new Promise((resolve, reject) => {
              // Pipe to the file and resolve when done
              res.body.pipe(outputFileStream)
              res.body.on('error', err => {
                reject(err)
              })
              outputFileStream.on('finish', () => resolve())
            })

            // Get the name of the author so it can be censored
            // TODO: Might need testing in prod, myMCPS has a specific format
            submission.authorName = await firestore.getUserName(
              submission.user_id.toString()
            )
            console.log(submission.authorName)

            // With the file downloaded it can be anonymized and the url can be changed to the new copy
            submission.attachments[0].url = await docx.anonymize(
              documentPath,
              submission.authorName.split(' ')
            )
          }

          // Add the assignment to firestore
          firestore
            .addAssignment(
              req.session.key + req.params.course,
              req.params.assignment,
              submissions,
              assignment.rubric
            )
            .then(n => {
              // Render a confirmation page and selector for number of reviews
              res.render('submissionInfo', {
                title: 'Peer Review',
                submissionCount: n,
                assignment: {
                  name: assignment.name,
                  course_id: req.params.course,
                  id: req.params.assignment
                }
              })
            })
            .catch(e => {
              console.log(e)
              res.status(500).send(e)
            })
        })
        .catch(e => {
          console.log(e)
          res.status(500).send(e)
        })
    })
    .catch(e => {
      console.log(e)
      res.status(500).send(e)
    })
})

router.get('/select/:course/:assignment', (req, res, next) => {
  // Context: Teacher has selected the assignment and chosen the number of reviews
  // This function assigns papers to students to review and stores that in Firestore

  // Restore provider from serialization
  req.session.provider = router.providers[req.session.providerId]

  // Get a list of all the submissions
  firestore
    .getSubmissions(req.params.assignment)
    .then(async submissions => {
      const submissionIds = submissions.map(s => s.id)
      // Use the assign function to match students
      const assignments = assign(submissionIds, parseInt(req.query.reviewNum))

      for (const authorPaperId in assignments) {
        const reviews = assignments[authorPaperId]

        // Since there is currently a list of submission ID's, we get the author from that
        // This is done to simplify the assignment algorithm and make it so only students who submitted get reviewed
        const authorSubmission = await firestore.getSubmission(authorPaperId)
        const author = await authorSubmission.get('author')
        reviews.map(async r => await firestore.assignReview(r, author))
      }
    })
    .catch(e => {
      console.log(e)
    })

  // Pass back the final URL that the assignment page will use as the External Tool
  req.session.provider.ext_content.send_lti_launch_url(
    res,
    'https://graded-peer-review.herokuapp.com/lti/assignment/' +
      req.session.key +
      req.params.course +
      '/' +
      req.params.assignment +
      '/review',
    'grr u',
    'hmmmm'
  )
})

module.exports = router
