docker pull 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/n11941073/assessment1/api:latest
docker pull 901444280953.dkr.ecr.ap-southeast-2.amazonaws.com/n11941073/assessment1/client:latest
sudo mkdir -p uploads db-data
sudo chown -R 1000:1000 uploads
sudo chmod -R 775 uploads
sudo docker compose up -d
