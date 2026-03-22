Assignment 2 - Cloud Services Exercises - Response to Criteria
================================================

Instructions
------------------------------------------------
- Keep this file named A2_response_to_criteria.md, do not change the name
- Upload this file along with your code in the root directory of your project
- Upload this file in the current Markdown format (.md extension)
- Do not delete or rearrange sections.  If you did not attempt a criterion, leave it blank
- Text inside [ ] like [eg. S3 ] are examples and should be removed


Overview
------------------------------------------------

- **Name:** Man Shing (Angus) Wong
- **Student number:** n11941073
- **Application name:** Where's My Bus
- **Two line description:** 

    The application contains a REST API and a Web client. The application provides live timetable updates on Translink services and allows users to rate, review, and upload images of public transport stops.

- **EC2 instance name or ID:** `i-004f74805292be9c7`

------------------------------------------------

### Core - First data persistence service

- **AWS service name:**  S3
- **What data is being stored?:** User-uploaded images
- **Why is this service suited to this data?:** Images can be stored and hosted in their original resolution easily
- **Why is are the other services used not suitable for this data?:** Images are unstructured data. Relational database will require the images to be transcoded before storage, increasing compute time and potentially loss of quality
- **Bucket/instance/table name:** `n11941073-wheresmybus`
- **Video timestamp:** `00:00`
- **Relevant files:**
    -`server/src/controllers/stops.controller.js`
    -`server/src/lib/s3Client.js`

### Core - Second data persistence service

- **AWS service name:**  RDS PostgreSQL
- **What data is being stored?:** User reviews, user-uploaded images metadata
- **Why is this service suited to this data?:** These data are strongly typed and structured, making it easy to store in a relational database.
- **Why is are the other services used not suitable for this data?:** Relational database provides the most efficient retrieval of data thanks to indices.
- **Bucket/instance/table name:** `s441.stop_image, s441.stop_review`
- **Video timestamp:** `00:45`
- **Relevant files:**
    -`server/src/models/db.js`
    -`server/src/controllers/stops.controller.js`

### Third data service

- **AWS service name:**  [eg. RDS]
- **What data is being stored?:** [eg video metadata]
- **Why is this service suited to this data?:** [eg. ]
- **Why is are the other services used not suitable for this data?:** [eg. Advanced video search requires complex querries which are not available on S3 and inefficient on DynamoDB]
- **Bucket/instance/table name:**
- **Video timestamp:**
- **Relevant files:**
    -

### S3 Pre-signed URLs

- **S3 Bucket names:** `n11941073-wheresmybus`
- **Video timestamp:** `01:24`
- **Relevant files:**
    -`server/src/lib/uploadTokenStore.js`
    -`server/src/lib/handoffStore.js`
    -`server/src/controllers/stops.controller.js`

### In-memory cache

- **ElastiCache instance name:** `n11941073-wheresmybus-realtimegtfs`
- **What data is being cached?:** Realtime decoded GTFS data from Translink API
- **Why is this data likely to be accessed frequently?:** Every user accesing the live timetable feature will use the live realtime Translink trip data. The application can simply fetch and decode this realtime data periodically (10 seconds as configured) and allow users to access it from cache.
- **Video timestamp:** `01:53`
- **Relevant files:**
    -`server/src/lib/cache.js`
    -`server/src/services/gtfsRealtime.service.js`
    -`server/src/controllers/stops.controller.js`

### Core - Statelessness

- **What data is stored within your application that is not stored in cloud data services?:** Static GTFS dataset from Translink
- **Why is this data not considered persistent state?:** Static dataset can easily be retrieved from Translink if lost
- **How does your application ensure data consistency if the app suddenly stops?:** Static dataset is rebuilt from Translink source when application first starts
- **Relevant files:**
    -`server/src/services/gtfsImport.service.js`

### Graceful handling of persistent connections

- **Type of persistent connection and use:** [eg. server-side-events for progress reporting]
- **Method for handling lost connections:** [eg. client responds to lost connection by reconnecting and indicating loss of connection to user until connection is re-established ]
- **Relevant files:**
    -


### Core - Authentication with Cognito

- **User pool name:** `n11941073-WheresMyBus`
- **How are authentication tokens handled by the client?:** Client directs user to Cognito login page. Login page returns a callback url. Callback parameter is passed to backend, then submitted to Cognito to redeem access token. Client stores access token in localstorage.
- **Video timestamp:** `03:18`
- **Relevant files:**
    -`server/src/lib/cognito.js`
    -`server/src/controllers/auth.controller.js`
    -`server/src/controllers/cognito.controller.js`

### Cognito multi-factor authentication

- **What factors are used for authentication:** Password, Email-code
- **Video timestamp:** `04:21`
- **Relevant files:**
    -Configured on AWS Console only

### Cognito federated identities

- **Identity providers used:** Google
- **Video timestamp:** `04:46`
- **Relevant files:**
    -Configured on AWS Console only

### Cognito groups

- **How are groups used to set permissions?:** "Admins" users can delete other users' uploaded images. "Users" can only delete their own uploaded images.
- **Video timestamp:** `05:15`
- **Relevant files:**
    -`server/src/controllers/stops.controller.js`

### Core - DNS with Route53

- **Subdomain**:  n11941073.wheresmybus.cab432.com
- **Video timestamp:** `06:10`

### Parameter store

- **Parameter names:** `/n11941073/url`
- **Video timestamp:** `06:36`
- **Relevant files:**
    -`server/src/lib/ssm.js`
    -`server/src/lib/publicBaseUrl.js`
    -`server/src/controllers/cognito.controller.js`

### Secrets manager

- **Secrets names:** `n11941073/assessment02/db`
- **Video timestamp:** `07:15`
- **Relevant files:**
    -`server/src/lib/secrets.js`
    -`server/src/models/db.js`

### Infrastructure as code

- **Technology used:** Terraform
- **Services deployed:** Secrets Manager, Cognito User Pool, Cognito Identity Provider, Elasticache Cluster, Cognito User Group, Systems Manager Parameter Store, S3 Bucket, Route53 Record
- **Video timestamp:** N/A
- **Relevant files:**
    -`terraform/main.tf`

### Other (with prior approval only)

- **Description:**
- **Video timestamp:**
- **Relevant files:**
    -

### Other (with prior permission only)

- **Description:**
- **Video timestamp:**
- **Relevant files:**
    -