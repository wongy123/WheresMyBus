provider "aws" {
  region  = "ap-southeast-2"
  profile = "CAB432-STUDENT-901444280953"
}

import {
  to = aws_elasticache_cluster.n11941073
  id = "n11941073-wheresmybus-realtimegtfs"
}

import {
  to = aws_route53_record.n11941073_cname
  id = "Z02680423BHWEVRU2JZDQ_n11941073.wheresmybus.cab432.com_CNAME"
}

import {
  to = aws_secretsmanager_secret.db
  id = "arn:aws:secretsmanager:ap-southeast-2:901444280953:secret:n11941073/assessment02/db-579bi4"
}

import {
  to = aws_secretsmanager_secret_version.db_value
  id = "arn:aws:secretsmanager:ap-southeast-2:901444280953:secret:n11941073/assessment02/db-579bi4|61001a4c-1a02-4ee6-bf77-fda640927f80"
}

import {
  to = aws_s3_bucket.n11941073_wheresmybus
  id = "n11941073-wheresmybus"
}

import {
  to = aws_cognito_user_pool.n11941073_wheresmybus
  id = "ap-southeast-2_itQrNJum0"
}

import {
  to = aws_cognito_identity_provider.google
  id = "ap-southeast-2_itQrNJum0:Google"
}

import {
  to = aws_ssm_parameter.n11941073_url
  id = "/n11941073/url"
}

import {
  to = aws_cognito_user_group.admins
  id = "ap-southeast-2_itQrNJum0/Admins"
}

import {
  to = aws_cognito_user_group.users
  id = "ap-southeast-2_itQrNJum0/Users"
}

import {
  to = aws_cognito_user_pool_client.wheresmybus
  id = "ap-southeast-2_itQrNJum0/5taq73ibsac3ditnhs4vlqnb7r"
}
